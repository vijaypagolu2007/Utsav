// Shared events: organizer publish / sync, public guest projection, guest self-service writes.
//
// Authorization model (no user accounts exist in this app):
//   • Organizer: a 256-bit random organizer token returned once at publish time. Only its SHA-256 hash is stored.
//     Sent as `Authorization: Bearer <token>` (a header, not a cookie, so CSRF doesn't apply). It is a capability,
//     not an identity: anyone holding it can edit the event.
//   • Household invite: one 256-bit token per household, carried in the URL fragment (#k=…) so it never reaches
//     server logs or Referer headers; the browser sends it as `X-Guest-Token`. It allows RSVP / diet / wishlist
//     actions for that household's members only.
//   • Public link without a token: read-only itinerary plus community sign-up (rate-limited).
// Every write goes through the deterministic reducer with role "guest" (allowlist) plus a per-guest scope check here.
import { z } from "zod";
import { AgentState } from "@/schema";
import { applyBatch, ClaimWishlistItem, CommunitySignup, findSubEvent, SetGuestDiet, SetRsvp } from "@/commands";
import { visibleSubEventIds } from "@/visibility";
import { toGuestView } from "@/guest-view";
import { fail, issuesOf, logServer, ok, randomId, safeEqual, sha256, type HandlerResult } from "./http";
import { getStore, type EventStore } from "./store";

export const EVENT_TTL_SEC = 180 * 24 * 3600;
export const MAX_PLAN_BYTES = 400 * 1024;
export const EVENTS_MAX_BODY_BYTES = 512 * 1024;
const EVENT_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const key = (id: string) => `utsav:event:${id}`;

const Invite = z.object({ householdId: z.string(), token: z.string().regex(TOKEN) });
const SharedEvent = z.object({
  id: z.string().regex(EVENT_ID),
  plan: AgentState,
  organizerTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  invites: z.array(Invite),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type SharedEvent = z.infer<typeof SharedEvent>;

export const RATE = {
  create: { limit: 10, windowSec: 3600 },
  publicRead: { limit: 120, windowSec: 60 },
  guestWrite: { limit: 30, windowSec: 60 },
  organizerWrite: { limit: 120, windowSec: 60 },
} as const;

function storeOr503(): { store: EventStore } | { result: HandlerResult } {
  const s = getStore();
  if (!s.store) return { result: fail(503, "storage_not_configured", s.reason ?? "Shared storage is not configured") };
  return { store: s.store };
}

async function limited(store: EventStore, scope: keyof typeof RATE, who: string): Promise<HandlerResult | null> {
  const r = RATE[scope];
  try {
    const n = await store.incr(`utsav:rl:${scope}:${who}`, r.windowSec);
    if (n > r.limit) return { status: 429, body: { error: "rate_limited", message: "Too many requests. Please wait a moment." }, headers: { "retry-after": String(r.windowSec) } };
  } catch (e) {
    logServer("events", "rate_limit_unavailable", { scope, message: e instanceof Error ? e.message : String(e) });
  }
  return null;
}

async function load(store: EventStore, id: string): Promise<{ rec: SharedEvent; version: number } | null> {
  if (!EVENT_ID.test(id)) return null;
  const v = await store.get(key(id));
  if (!v) return null;
  let raw: unknown;
  try { raw = JSON.parse(v.json); } catch { logServer("events", "corrupt_record", { id }); return null; }
  const p = SharedEvent.safeParse(raw);
  if (!p.success) { logServer("events", "invalid_record", { id, issues: issuesOf(p.error.issues).join("; ") }); return null; }
  return { rec: p.data, version: v.version };
}

const NOT_FOUND = () => fail(404, "not_found", "This event link is invalid or has expired");
const UNAUTHORIZED = () => fail(401, "unauthorized", "Organizer token missing or invalid");

const organizerOk = (rec: SharedEvent, token: string | null) => !!token && TOKEN.test(token) && safeEqual(sha256(token), rec.organizerTokenHash);
const householdFor = (rec: SharedEvent, token: string | null): string | null => {
  if (!token || !TOKEN.test(token)) return null;
  for (const i of rec.invites) if (safeEqual(i.token, token)) return i.householdId;
  return null;
};

/** One invite per household that has guests; existing tokens are kept stable. */
function withInvites(plan: AgentState, existing: SharedEvent["invites"]): SharedEvent["invites"] {
  const live = new Set(plan.guests.map(g => g.householdId));
  const kept = existing.filter(i => live.has(i.householdId));
  const have = new Set(kept.map(i => i.householdId));
  for (const h of plan.households) if (live.has(h.id) && !have.has(h.id)) kept.push({ householdId: h.id, token: randomId(32) });
  return kept;
}
const inviteList = (rec: SharedEvent) => rec.invites.map(i => ({
  householdId: i.householdId, label: rec.plan.households.find(h => h.id === i.householdId)?.label ?? i.householdId, token: i.token,
}));

function parsePlan(raw: unknown): { ok: true; plan: AgentState } | { ok: false; result: HandlerResult } {
  const p = AgentState.safeParse(raw);
  if (!p.success) return { ok: false, result: fail(400, "invalid_state", "The plan failed validation", { issues: issuesOf(p.error.issues) }) };
  if (JSON.stringify(p.data).length > MAX_PLAN_BYTES) return { ok: false, result: fail(413, "plan_too_large", "The plan is too large to share") };
  return { ok: true, plan: p.data };
}

// ---------- organizer ----------
export async function createSharedEvent(raw: unknown, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = z.object({ plan: z.unknown() }).strict().safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { plan }");
  const p = parsePlan(body.data.plan); if (!p.ok) return p.result;
  const rl = await limited(s.store, "create", ip); if (rl) return rl;
  const organizerToken = randomId(32);
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomId(16);
    const rec: SharedEvent = { id, plan: p.plan, organizerTokenHash: sha256(organizerToken), invites: withInvites(p.plan, []), createdAt: now, updatedAt: now };
    if (await s.store.create(key(id), JSON.stringify(rec), EVENT_TTL_SEC)) {
      logServer("events", "created", { id, households: rec.invites.length });
      return ok({ eventId: id, organizerToken, version: 1, invites: inviteList(rec) }, 201);
    }
  }
  return fail(500, "id_collision", "Could not allocate an event id");
}

export async function getOrganizerEvent(id: string, token: string | null): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
  return ok({ eventId: id, version: r.version, plan: r.rec.plan, invites: inviteList(r.rec), updatedAt: r.rec.updatedAt });
}

export async function putOrganizerEvent(id: string, token: string | null, raw: unknown): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = z.object({ plan: z.unknown(), baseVersion: z.number().int().positive() }).strict().safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { plan, baseVersion }");
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
  const rl = await limited(s.store, "organizerWrite", id); if (rl) return rl;
  const p = parsePlan(body.data.plan); if (!p.ok) return p.result;
  if (body.data.baseVersion !== r.version) return conflict(r);
  const rec: SharedEvent = { ...r.rec, plan: p.plan, invites: withInvites(p.plan, r.rec.invites), updatedAt: new Date().toISOString() };
  const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
  if (!w.ok) { const fresh = await load(s.store, id); return fresh ? conflict(fresh) : NOT_FOUND(); }
  return ok({ eventId: id, version: w.version, invites: inviteList(rec) });
}

/** 409 carries the current server copy so the organizer client can rebase guest changes and retry explicitly. */
const conflict = (r: { rec: SharedEvent; version: number }) =>
  fail(409, "version_conflict", "The event changed since your last sync (probably a guest response). Merge and retry.", { current: { version: r.version, plan: r.rec.plan } });

// ---------- guests ----------
export async function getGuestView(id: string, guestToken: string | null, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const rl = await limited(s.store, "publicRead", ip); if (rl) return rl;
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  const hh = householdFor(r.rec, guestToken);
  if (guestToken && !hh) return fail(403, "invalid_invite", "This invite link is no longer valid. Ask the organizer for a new one.");
  return ok(toGuestView(r.rec.plan, id, r.version, hh));
}

const GuestCommand = z.discriminatedUnion("op", [SetRsvp.strict(), SetGuestDiet.strict(), ClaimWishlistItem.strict(), CommunitySignup.strict()]);
export const GuestActionRequest = z.object({ commands: z.array(GuestCommand).min(1).max(10) }).strict();

export async function postGuestActions(id: string, guestToken: string | null, raw: unknown, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = GuestActionRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Only RSVP, diet, wishlist and sign-up actions are accepted", { issues: issuesOf(body.error.issues) });
  const rl = await limited(s.store, "guestWrite", `${id}:${ip}`); if (rl) return rl;
  const commands = body.data.commands;
  for (const c of commands) {
    if (c.op === "community_signup" && c.name.trim().length > 80) return fail(400, "invalid_request", "Name is too long");
    if (c.op === "set_guest_diet" && (c.diet.length > 8 || c.diet.some(d => d.length > 40))) return fail(400, "invalid_request", "Too many or too long diet tags");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    const hh = householdFor(r.rec, guestToken);
    if (guestToken && !hh) return fail(403, "invalid_invite", "This invite link is no longer valid");
    // Scope check (IDOR): every guest-targeted command must name a member of the caller's own household.
    const members = new Set(hh ? r.rec.plan.guests.filter(g => g.householdId === hh).map(g => g.id) : []);
    for (const c of commands) {
      if (c.op === "community_signup") continue;
      if (!hh) return fail(401, "invite_required", "Use your personal invite link to RSVP or claim a gift");
      const gid = c.guestId;
      if (gid === null) return fail(403, "forbidden", "Releasing a claim is done by the organizer");
      if (!members.has(gid)) return fail(403, "forbidden", "You can only respond for your own household");
    }
    // A guest may only name sub-events they can see. Hidden ones get the same answer as a nonexistent one, so the
    // endpoint can't be used to probe for private sub-events (or leak their names through reducer error text).
    const visible = visibleSubEventIds(r.rec.plan, members);
    for (const c of commands) {
      const ref = c.op === "set_rsvp" ? c.subEvent : c.op === "community_signup" ? c.subEvent : undefined;
      if (ref === undefined) continue;
      let sid: string | null = null;
      try { sid = findSubEvent(r.rec.plan, ref).id; } catch { sid = null; }
      if (!sid || !visible.has(sid)) return fail(400, "unknown_sub_event", "That event isn't on your itinerary");
    }
    const res = applyBatch(r.rec.plan, { summary: "Guest self-service", commands }, { role: "guest" });
    if (!res.ok) return fail(422, "rejected", res.reason, { failedCommandIndex: res.failedCommandIndex });
    const rec: SharedEvent = { ...r.rec, plan: res.state, updatedAt: new Date().toISOString() };
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    // On a version conflict we reload and re-validate against the fresh plan (e.g. a gift claimed meanwhile).
    if (w.ok) return ok({ log: res.log, view: toGuestView(res.state, id, w.version, hh) });
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}
