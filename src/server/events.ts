// Shared events: organizer publish / sync, public guest projection, guest self-service writes.
//
// Authorization model (no user accounts exist in this app):
//   • Organizer: a 256-bit random organizer token returned once at publish time. Only its SHA-256 hash is stored.
//     Sent as `Authorization: Bearer <token>` (a header, not a cookie, so CSRF doesn't apply). It is a capability,
//     not an identity: anyone holding it can edit the event.
//   • RSVP link (v8 Part 1c, "open RSVP"): one 256-bit token per event, carried in the URL fragment (#k=…) so it never
//     reaches server logs or Referer headers; the browser sends it as `X-Guest-Token`. The organizer shares it anywhere
//     (a WhatsApp group, a printed QR). Anyone with it can send an RSVP; nobody needs to be on a guest list first.
//   • Device token (v8 Part 1c): a random UUID the guest's browser keeps per event (localStorage) and sends as
//     `X-Device-Token`. It is the upsert key: the same device edits its own RSVP. Only a salted hash is stored, in this
//     server-side record (rsvpIndex), never in the plan the organizer syncs.
//   • Household invite (v8 Part 1, kept so links already sent keep working): it now opens the same open RSVP form and
//     shows nothing about the household.
//   • Public link without a token: read-only itinerary plus community sign-up (rate-limited).
// Dedupe: a phone is stored twice, as the real number in the plan (organizer-only) and as a salted hash here. A NEW device
// sending a phone whose hash is already on an entry never overwrites it: a second entry is made, flagged
// possibleDuplicateOf, for the organizer to merge or delete. Without a phone, a new device is always a new entry (an
// accepted trade-off: a family that answers from two phones without a number shows up twice until the organizer merges).
// Every write goes through the deterministic reducer with role "guest" (allowlist) and the device's entry as the actor.
import { z } from "zod";
import { AgentState, RSVP_ENTRIES_CAP, RSVP_MAX_PARTY, RSVP_NAME_MAX, RsvpAnswer, RsvpMeal } from "@/schema";
import { applyBatch, ClaimWishlistItem, CommunitySignup, findSubEvent, GUEST_LIMITS } from "@/commands";
import { visibleSubEventIds } from "@/visibility";
import { toGuestView, type GuestAccess } from "@/guest-view";
import { normalizePhone } from "@/phone";
import { RSVP_CLOSED_MESSAGE, RSVP_DUPLICATE_MESSAGE, RSVP_ENTRY_ID, RSVP_REMOVED_MESSAGE, rsvpClosed, rsvpFunctions } from "@/rsvp";
import { fail, issuesOf, logServer, ok, randomId, safeEqual, sha256, type HandlerResult } from "./http";
import { getStore, type EventStore } from "./store";

export const EVENT_TTL_SEC = 180 * 24 * 3600;
export const MAX_PLAN_BYTES = 400 * 1024;
export const EVENTS_MAX_BODY_BYTES = 512 * 1024;
const EVENT_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const key = (id: string) => `utsav:event:${id}`;

const Invite = z.object({ householdId: z.string(), token: z.string().regex(TOKEN) });
const HEX64 = /^[0-9a-f]{64}$/;
/** v8 Part 1c: which device (and which phone) wrote which RSVP entry. Hashes only (salted with rsvpSalt). Never sent out. */
const RsvpIndexRow = z.object({ entryId: z.string().regex(RSVP_ENTRY_ID), device: z.string().regex(HEX64), phone: z.string().regex(HEX64).nullable() });
const SharedEvent = z.object({
  id: z.string().regex(EVENT_ID),
  plan: AgentState,
  organizerTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  invites: z.array(Invite),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** v8 Part 0c: the organizer deleted the event. Guest links answer 410 until it is restored. */
  removedAt: z.string().optional(),
  /** v8 Part 1: the group join link's token. Absent means the join link is switched off. */
  join: z.object({ token: z.string().regex(TOKEN), since: z.string() }).optional(),
  /** v8 Part 1c: the event's one RSVP link. Records saved before it get one on the next sync (or Reset). */
  rsvp: z.object({ token: z.string().regex(TOKEN), since: z.string() }).optional(),
  /** v8 Part 1c: the per-event salt for device and phone hashes (made on the first RSVP). Server-only. */
  rsvpSalt: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/).optional(),
  rsvpIndex: z.array(RsvpIndexRow).max(RSVP_ENTRIES_CAP * 2).default([]),
});
type SharedEvent = z.infer<typeof SharedEvent>;

export const RATE = {
  create: { limit: 10, windowSec: 3600 },
  publicRead: { limit: 120, windowSec: 60 },
  guestWrite: { limit: 30, windowSec: 60 },
  organizerWrite: { limit: 120, windowSec: 60 },
  // Signed-in cloud save (src/server/cloud-handler.ts): per IP before the ID token is checked, per user after.
  cloudIp: { limit: 300, windowSec: 60 },
  cloudRead: { limit: 120, windowSec: 60 },
  cloudWrite: { limit: 60, windowSec: 60 },
  // v8 Part 1: the public group join link. Per IP and event; a person needs one or two tries, a bot gets five per 10 min.
  join: { limit: 5, windowSec: 600 },
  // v8 Part 1c: the open RSVP form. Per IP and event, generous because one Jio or Airtel CGNAT address can be a whole
  // wedding's worth of phones; plus a tighter limit per device token, so one browser can't flood the list.
  rsvpIp: { limit: 30, windowSec: 600 },
  rsvpDevice: { limit: 10, windowSec: 600 },
} as const;

function storeOr503(): { store: EventStore } | { result: HandlerResult } {
  const s = getStore();
  if (!s.store) return { result: fail(503, "storage_not_configured", s.reason ?? "Shared storage is not configured") };
  return { store: s.store };
}

/** Fixed-window rate limit in the shared store; a store outage never blocks the request (it is logged). */
export async function limited(store: EventStore, scope: keyof typeof RATE, who: string): Promise<HandlerResult | null> {
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
/** v8 Part 0c: the same answer for every guest request to a deleted event (nothing about it, its households or RSVPs). */
export const REMOVED_MESSAGE = "This event was removed by the organizer";
const GONE = () => fail(410, "event_removed", REMOVED_MESSAGE);
const UNAUTHORIZED = () => fail(401, "unauthorized", "Organizer token missing or invalid");

const organizerOk = (rec: SharedEvent, token: string | null) => !!token && TOKEN.test(token) && safeEqual(sha256(token), rec.organizerTokenHash);
const householdFor = (rec: SharedEvent, token: string | null): string | null => {
  if (!token || !TOKEN.test(token)) return null;
  let hid: string | null = null;
  for (const i of rec.invites) if (safeEqual(i.token, token)) hid = i.householdId;
  return hid;
};
/**
 * v8 Part 1c: what a guest token unlocks. Every token is compared in constant time. The RSVP link and an old Part 1
 * household link both open the open RSVP form (a household link shows nothing about its household any more).
 */
export type Access = { kind: "open"; via: "rsvp" | "household" };
export function accessFor(rec: SharedEvent, token: string | null): Access | null {
  if (!token || !TOKEN.test(token)) return null;
  if (rec.rsvp && safeEqual(rec.rsvp.token, token)) return { kind: "open", via: "rsvp" };
  return householdFor(rec, token) ? { kind: "open", via: "household" } : null;
}
const freshRsvp = () => ({ token: randomId(32), since: new Date().toISOString() });
/** What every organizer answer carries about the links (v8 Part 1c: the household invites and the one RSVP link). */
const linksOf = (rec: SharedEvent) => ({ invites: inviteList(rec), rsvpToken: rec.rsvp?.token ?? null });

// ---------- v8 Part 1c: device tokens, phone hashes and dedupe ----------
/** A browser's device token: a random (v4) UUID. */
export const DEVICE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const deviceHash = (salt: string, device: string) => sha256(`device:${salt}:${device.toLowerCase()}`);
/** The salted hash of an E.164 phone: equal numbers give equal hashes within one event, and nothing outside it. */
export const phoneHash = (salt: string, e164: string) => sha256(`phone:${salt}:${e164}`);
type IndexRow = z.infer<typeof RsvpIndexRow>;
/** Follow mergedInto (bounded) to the entry a device now edits. */
function resolveEntry(plan: AgentState, id: string) {
  let e = plan.rsvpEntries.find(x => x.id === id);
  for (let i = 0; e?.mergedInto && i < 5; i++) { const to: string = e.mergedInto; e = plan.rsvpEntries.find(x => x.id === to); }
  return e && !e.mergedInto ? e : undefined;
}
/** The entry this device wrote (after merges), or undefined. */
export function entryForDevice(plan: AgentState, index: IndexRow[], dHash: string) {
  const row = index.find(r => safeEqual(r.device, dHash));
  return row ? resolveEntry(plan, row.entryId) : undefined;
}
export type RsvpWritePlan =
  | { kind: "removed" }
  | { kind: "update"; entryId: string; duplicateOf: string | null }
  | { kind: "create"; duplicateOf: string | null };
/**
 * Pure: what one RSVP write does. The device's own entry is updated (never anybody else's); a removed one stays removed.
 * A phone hash that matches another live entry flags this one as its possible duplicate, never overwriting it.
 */
export function planRsvpWrite(plan: AgentState, index: IndexRow[], dHash: string, pHash: string | null): RsvpWritePlan {
  const mine = entryForDevice(plan, index, dHash);
  if (mine?.removedAt) return { kind: "removed" };
  let dup: string | null = null;
  if (pHash) for (const r of index) {
    if (!safeEqual(r.phone ?? "", pHash)) continue;
    const other = resolveEntry(plan, r.entryId);
    if (other && !other.removedAt && other.id !== mine?.id) { dup = other.id; break; }
  }
  return mine ? { kind: "update", entryId: mine.id, duplicateOf: dup } : { kind: "create", duplicateOf: dup };
}

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
    const rec: SharedEvent = { id, plan: p.plan, organizerTokenHash: sha256(organizerToken), invites: withInvites(p.plan, []), rsvp: freshRsvp(), rsvpIndex: [], createdAt: now, updatedAt: now };
    if (await s.store.create(key(id), JSON.stringify(rec), EVENT_TTL_SEC)) {
      logServer("events", "created", { id, households: rec.invites.length });
      return ok({ eventId: id, organizerToken, version: 1, ...linksOf(rec) }, 201);
    }
  }
  return fail(500, "id_collision", "Could not allocate an event id");
}

export async function getOrganizerEvent(id: string, token: string | null): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
  return ok({ eventId: id, version: r.version, plan: r.rec.plan, ...linksOf(r.rec), joinToken: r.rec.join?.token ?? null, updatedAt: r.rec.updatedAt, ...(r.rec.removedAt ? { removedAt: r.rec.removedAt } : {}) });
}

export const RemoveRequest = z.object({ removed: z.boolean() }).strict();
/**
 * PATCH /api/events/:id { removed } (organizer token): deleting the event in the planner switches its guest links off
 * (410 for every guest read and write); restoring it switches them back on, with the same invite tokens.
 */
export async function setOrganizerEventRemoved(id: string, token: string | null, raw: unknown): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = RemoveRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { removed: boolean }");
  const rl = await limited(s.store, "organizerWrite", id); if (rl) return rl;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
    if (!!r.rec.removedAt === body.data.removed) return ok({ eventId: id, version: r.version, removed: body.data.removed });
    const now = new Date().toISOString();
    const rec: SharedEvent = { ...r.rec, updatedAt: now };
    if (body.data.removed) rec.removedAt = now; else delete rec.removedAt;
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    if (w.ok) { logServer("events", body.data.removed ? "removed" : "restored", { id }); return ok({ eventId: id, version: w.version, removed: body.data.removed }); }
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}

export async function putOrganizerEvent(id: string, token: string | null, raw: unknown): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = z.object({ plan: z.unknown(), baseVersion: z.number().int().positive() }).strict().safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { plan, baseVersion }");
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
  if (r.rec.removedAt) return GONE();
  const rl = await limited(s.store, "organizerWrite", id); if (rl) return rl;
  const p = parsePlan(body.data.plan); if (!p.ok) return p.result;
  if (body.data.baseVersion !== r.version) return conflict(r);
  const rec: SharedEvent = { ...r.rec, plan: p.plan, invites: withInvites(p.plan, r.rec.invites),
    rsvp: r.rec.rsvp ?? freshRsvp(), updatedAt: new Date().toISOString() };
  const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
  if (!w.ok) { const fresh = await load(s.store, id); return fresh ? conflict(fresh) : NOT_FOUND(); }
  return ok({ eventId: id, version: w.version, ...linksOf(rec) });
}

/** 409 carries the current server copy so the organizer client can rebase guest changes and retry explicitly. */
const conflict = (r: { rec: SharedEvent; version: number }) =>
  fail(409, "version_conflict", "The event changed since your last sync (probably a guest response). Merge and retry.", { current: { version: r.version, plan: r.rec.plan } });

// ---------- guests ----------
/** The device's own entry id when this is the RSVP link and the device has answered (null otherwise). */
function myEntryId(rec: SharedEvent, a: Access | null, device: string | null): string | null {
  if (!a || !device || !DEVICE_TOKEN.test(device) || !rec.rsvpSalt) return null;
  return entryForDevice(rec.plan, rec.rsvpIndex, deviceHash(rec.rsvpSalt, device))?.id
    // A removed entry has no resolved survivor: find the row directly so the guest sees "removed".
    ?? rec.rsvpIndex.find(r => safeEqual(r.device, deviceHash(rec.rsvpSalt!, device)))?.entryId ?? null;
}
const viewFor = (rec: SharedEvent, version: number, a: Access | null, device: string | null): ReturnType<typeof toGuestView> =>
  toGuestView(rec.plan, rec.id, version, a ? { kind: "open", entryId: myEntryId(rec, a, device) } : { kind: "public" } satisfies GuestAccess);

export async function getGuestView(id: string, guestToken: string | null, ip: string, device: string | null = null): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const rl = await limited(s.store, "publicRead", ip); if (rl) return rl;
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  // Checked before the invite token, so a deleted event says the same thing to every link (no household probing).
  if (r.rec.removedAt) return GONE();
  const a = accessFor(r.rec, guestToken);
  if (guestToken && !a) return fail(403, "invalid_invite", "This invite link is no longer valid. Ask the organizer for a new one.");
  return ok(viewFor(r.rec, r.version, a, device));
}

// v8 Part 1c: the guest endpoint now runs gift claims and community sign-ups only. RSVPs go through postRsvp below;
// request_join runs only through postJoinRequest (the reducer enforces the same rules).
const GuestCommand = z.discriminatedUnion("op", [ClaimWishlistItem.strict(), CommunitySignup.strict()]);
export const GuestActionRequest = z.object({ commands: z.array(GuestCommand).min(1).max(10) }).strict();

export async function postGuestActions(id: string, guestToken: string | null, raw: unknown, ip: string, device: string | null = null): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = GuestActionRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Only gift claims and sign-ups are accepted here", { issues: issuesOf(body.error.issues) });
  const rl = await limited(s.store, "guestWrite", `${id}:${ip}`); if (rl) return rl;
  const commands = body.data.commands;
  for (const c of commands) if (c.op === "community_signup" && c.name.trim().length > 80) return fail(400, "invalid_request", "Name is too long");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    if (r.rec.removedAt) return GONE();
    const a = accessFor(r.rec, guestToken);
    if (guestToken && !a) return fail(403, "invalid_invite", "This invite link is no longer valid");
    // Scope (IDOR): a claim is made for, or released from, this device's own live RSVP only.
    const mine = myEntryId(r.rec, a, device);
    const live = mine ? r.rec.plan.rsvpEntries.some(e => e.id === mine && !e.removedAt && !e.mergedInto) : false;
    for (const c of commands) {
      if (c.op === "community_signup") continue;
      if (!a) return fail(401, "invite_required", "Use your RSVP link to claim a gift");
      if (!live) return fail(403, "rsvp_required", "Send your RSVP first, then you can claim a gift");
      if (c.guestId !== null && c.guestId !== mine) return fail(403, "forbidden", "You can only claim a gift for yourself");
    }
    // A sign-up may only name sub-events this link can see (the same answer as a nonexistent one, so nothing is probed).
    const visible = a ? new Set([...visibleSubEventIds(r.rec.plan, []), ...rsvpFunctions(r.rec.plan).map(x => x.id)]) : visibleSubEventIds(r.rec.plan, []);
    for (const c of commands) {
      if (c.op !== "community_signup" || c.subEvent === undefined) continue;
      let sid: string | null = null;
      try { sid = findSubEvent(r.rec.plan, c.subEvent).id; } catch { sid = null; }
      if (!sid || !visible.has(sid)) return fail(400, "unknown_sub_event", "That event isn't on your itinerary");
    }
    const res = applyBatch(r.rec.plan, { summary: "Guest self-service", commands },
      { role: "guest", source: "guest_link", now: new Date().toISOString(), ...(live ? { actorEntryId: mine } : {}) });
    if (!res.ok) return fail(422, "rejected", res.reason, { failedCommandIndex: res.failedCommandIndex });
    const rec: SharedEvent = { ...r.rec, plan: res.state, updatedAt: new Date().toISOString() };
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    // On a version conflict we reload and re-validate against the fresh plan (e.g. a gift claimed meanwhile).
    if (w.ok) return ok({ log: res.log, view: viewFor(rec, w.version, a, device) });
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}

// ---------- v8 Part 1c: the open RSVP form ----------
/** The guest form's body. Strict: an unknown key is a 400. `website` is the honeypot (a field people never see). */
export const RsvpRequest = z.object({
  name: z.string().trim().min(1, "Enter your name").max(RSVP_NAME_MAX, `Keep your name under ${RSVP_NAME_MAX} characters`),
  /** As typed; "" or absent keeps the number already on file. */
  phone: z.string().trim().max(40).optional(),
  partySize: z.number().int().min(1).max(RSVP_MAX_PARTY),
  kids: z.number().int().min(0).max(RSVP_MAX_PARTY).optional(),
  /** Sub-event ids, as the form lists them. */
  functions: z.array(z.string().min(1).max(80)).max(30),
  meal: RsvpMeal,
  answer: RsvpAnswer,
  website: z.string().max(200).optional(),
}).strict();
export const RSVP_MAX_BODY_BYTES = 4 * 1024;
const CLOSED = () => fail(403, "rsvp_closed", RSVP_CLOSED_MESSAGE);

/**
 * POST /api/events/:id/rsvp with X-Guest-Token (the RSVP link) and X-Device-Token. Creates this device's RSVP, or updates
 * it. Order: body (Zod, size-capped by the route) → device token → rate limits (IP, then device) → honeypot → phone →
 * load → removed event (410) → link → close date (403, reads still work) → dedupe → reducer → plan size → CAS.
 * The answer carries this device's view only: never another entry, never a phone.
 */
export async function postRsvp(id: string, guestToken: string | null, device: string | null, raw: unknown, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = RsvpRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", body.error.issues[0]?.message ?? "Please check the form", { issues: issuesOf(body.error.issues) });
  if (!device || !DEVICE_TOKEN.test(device)) return fail(400, "device_required", "This browser couldn't keep your RSVP. Allow site storage and try again.");
  const rl = await limited(s.store, "rsvpIp", `${id}:${ip}`); if (rl) return rl;
  const rd = await limited(s.store, "rsvpDevice", `${id}:${sha256(`rl:${device.toLowerCase()}`).slice(0, 32)}`); if (rd) return rd;
  const f = body.data;
  if (f.website) { logServer("events", "rsvp_honeypot", { id }); return ok({ result: "saved" }); }
  let e164: string | null = null;
  if (f.phone) {
    const p = normalizePhone(f.phone);
    if (!p.ok) return fail(400, "invalid_phone", `That phone number doesn't look right (${p.reason})`);
    e164 = p.e164;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    if (r.rec.removedAt) return GONE();
    const a = accessFor(r.rec, guestToken);
    if (!a) return guestToken ? fail(403, "invalid_invite", "This RSVP link is no longer valid. Ask the organizer for a new one.") : fail(401, "invite_required", "Open the RSVP link your hosts shared to answer");
    const now = new Date().toISOString();
    if (rsvpClosed(r.rec.plan.rsvpSettings, now)) return CLOSED();
    const salt = r.rec.rsvpSalt ?? randomId(24);
    const dHash = deviceHash(salt, device);
    const pHash = e164 ? phoneHash(salt, e164) : null;
    const plan = planRsvpWrite(r.rec.plan, r.rec.rsvpIndex, dHash, pHash);
    if (plan.kind === "removed") return fail(403, "rsvp_removed", RSVP_REMOVED_MESSAGE);
    const entryId = plan.kind === "update" ? plan.entryId : `r-${randomId(12)}`;
    const res = applyBatch(r.rec.plan, { summary: "RSVP", commands: [{ op: "submit_rsvp_entry", entryId, name: f.name, ...(e164 ? { phone: e164 } : {}),
      partySize: f.partySize, ...(f.kids !== undefined ? { kids: f.kids } : {}), functions: f.functions, meal: f.meal, answer: f.answer, duplicateOf: plan.duplicateOf }] },
      { role: "guest", source: "rsvp_link", now, actorEntryId: entryId });
    if (!res.ok) {
      if (res.reason === RSVP_CLOSED_MESSAGE) return CLOSED();
      if (/list is full/.test(res.reason)) return fail(409, "rsvp_list_full", res.reason);
      return fail(422, "rejected", res.reason);
    }
    // The plan (entries included) must stay under the size limit it shares with cloud save.
    if (JSON.stringify(res.state).length > MAX_PLAN_BYTES) return fail(409, "rsvp_list_full", "This RSVP list is full. Please contact the organizer.");
    const index = plan.kind === "create" ? [...r.rec.rsvpIndex, { entryId, device: dHash, phone: pHash }]
      : r.rec.rsvpIndex.map(x => safeEqual(x.device, dHash) && pHash ? { ...x, phone: pHash } : x);
    const rec: SharedEvent = { ...r.rec, plan: res.state, rsvpSalt: salt, rsvpIndex: index, updatedAt: now };
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    if (w.ok) {
      // Counts only: no names, phones or tokens in logs.
      logServer("events", plan.kind === "create" ? "rsvp_created" : "rsvp_updated", { id, duplicate: !!plan.duplicateOf });
      return ok({ result: plan.kind === "create" ? "created" : "updated", duplicate: !!plan.duplicateOf,
        ...(plan.duplicateOf ? { message: RSVP_DUPLICATE_MESSAGE } : {}), view: viewFor(rec, w.version, a, device) });
    }
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}


// ---------- v8 Part 1: reset a household's link, the group join link, join requests ----------
const RESET_OK = (rec: SharedEvent, version: number) => ok({ eventId: rec.id, version, ...linksOf(rec), joinToken: rec.join?.token ?? null });

/** Load → organizer check → change the record → CAS, retried on a concurrent write. `change` returns null to refuse. */
async function organizerUpdate(id: string, token: string | null, change: (rec: SharedEvent) => SharedEvent | HandlerResult): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const rl = await limited(s.store, "organizerWrite", id); if (rl) return rl;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    if (!organizerOk(r.rec, token)) return UNAUTHORIZED();
    if (r.rec.removedAt) return GONE();
    const next = change(r.rec);
    if ("status" in next) return next;
    const rec: SharedEvent = { ...next, updatedAt: new Date().toISOString() };
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    if (w.ok) return RESET_OK(rec, w.version);
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}

export const ResetInviteRequest = z.union([
  z.object({ householdId: z.string().min(1).max(80) }).strict(),
  z.object({ rsvpLink: z.literal(true) }).strict(),
]);
/**
 * POST /api/events/:id/invites (organizer): a new token for one link. The old link stops working at once (403 "no longer
 * valid"); answers are untouched. Not undoable on purpose: undoing would bring a forwarded link back to life.
 *   { householdId }  a Part 1 household link (it opens the open RSVP form)
 *   { rsvpLink }     v8 Part 1c: the event's RSVP link (made fresh when an older record has none yet). RSVPs already sent
 *                    stay; a device that answered keeps editing its RSVP once it has the new link.
 */
export async function resetHouseholdInvite(id: string, token: string | null, raw: unknown): Promise<HandlerResult> {
  const body = ResetInviteRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { householdId } or { rsvpLink: true }");
  if ("rsvpLink" in body.data) {
    return organizerUpdate(id, token, rec => { logServer("events", "rsvp_link_reset", { id }); return { ...rec, rsvp: freshRsvp() }; });
  }
  const hid = body.data.householdId;
  return organizerUpdate(id, token, rec => {
    if (!rec.invites.some(i => i.householdId === hid)) return fail(404, "no_invite", "That household has no link yet (add a guest to it and sync first)");
    logServer("events", "invite_reset", { id });
    return { ...rec, invites: rec.invites.map(i => (i.householdId === hid ? { householdId: hid, token: randomId(32) } : i)) };
  });
}

export const JoinLinkRequest = z.object({ action: z.enum(["enable", "rotate", "disable"]) }).strict();
/** POST /api/events/:id/join-link { action } (organizer): switch the group join link on (same token if already on), give it a new token, or off. */
export async function setJoinLink(id: string, token: string | null, raw: unknown): Promise<HandlerResult> {
  const body = JoinLinkRequest.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Expected { action: enable | rotate | disable }");
  const a = body.data.action;
  return organizerUpdate(id, token, rec => {
    logServer("events", `join_link_${a}`, { id });
    if (a === "disable") { const { join: _off, ...rest } = rec; void _off; return rest; }
    if (a === "enable" && rec.join) return rec;
    return { ...rec, join: { token: randomId(32), since: new Date().toISOString() } };
  });
}

const joinOk = (rec: SharedEvent, t: string | null) => !!rec.join && !!t && TOKEN.test(t) && safeEqual(rec.join.token, t);
const JOIN_OFF = () => fail(403, "join_disabled", "This join link isn't active. Ask the organizer for a new one.");

/** GET /api/events/:id/join?t=… : what the join page needs (title, hosts, dates), only for a valid, switched-on link. */
export async function getJoinInfo(id: string, t: string | null, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const rl = await limited(s.store, "publicRead", ip); if (rl) return rl;
  const r = await load(s.store, id);
  if (!r) return NOT_FOUND();
  if (r.rec.removedAt) return GONE();
  if (!joinOk(r.rec, t)) return JOIN_OFF();
  const v = toGuestView(r.rec.plan, id, r.version, null);
  return ok({ eventId: id, title: v.title, hosts: v.hosts, city: v.city, startDate: v.startDate, endDate: v.endDate, eventType: v.eventType, maxSize: GUEST_LIMITS.maxHouseholdSize });
}

export const JoinRequestBody = z.object({
  t: z.string().max(64),
  name: z.string().trim().min(1, "Enter your name").max(80),
  size: z.number().int().min(1).max(GUEST_LIMITS.maxHouseholdSize),
  phone: z.string().trim().max(40).optional(),
  /** Honeypot: a field people never see. Anything in it means a bot. */
  website: z.string().max(200).optional(),
}).strict();
const JOIN_ACCEPTED = () => ok({ ok: true, message: "Request sent. The hosts will share the RSVP link with you once they approve it." }, 202);

/**
 * POST /api/events/:id/join (public, rate limited): ask to be added to the guest list through the organizer's group join
 * link. The request waits in the organizer's queue; nothing about the guest list is returned, and a repeated request or a
 * honeypot hit gets the same 202 as a new one, so the endpoint can't be used to probe who is already invited.
 */
export async function postJoinRequest(id: string, raw: unknown, ip: string): Promise<HandlerResult> {
  const s = storeOr503(); if ("result" in s) return s.result;
  const body = JoinRequestBody.safeParse(raw);
  if (!body.success) return fail(400, "invalid_request", "Please check your name, household size and phone number", { issues: issuesOf(body.error.issues) });
  const rl = await limited(s.store, "join", `${id}:${ip}`); if (rl) return rl;
  if (body.data.website) { logServer("events", "join_honeypot", { id }); return JOIN_ACCEPTED(); }
  const requestId = randomId(12);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await load(s.store, id);
    if (!r) return NOT_FOUND();
    if (r.rec.removedAt) return GONE();
    if (!joinOk(r.rec, body.data.t)) return JOIN_OFF();
    const now = new Date().toISOString();
    const res = applyBatch(r.rec.plan, { summary: "Join request", commands: [{ op: "request_join", requestId, name: body.data.name, size: body.data.size,
      ...(body.data.phone ? { phone: body.data.phone } : {}), at: now }] }, { role: "guest", source: "join", now });
    if (!res.ok) {
      const full = /too many requests/i.test(res.reason);
      return full ? fail(429, "join_queue_full", res.reason) : fail(422, "rejected", res.reason);
    }
    if (res.state === r.rec.plan) return JOIN_ACCEPTED(); // already pending: same answer, nothing written
    const rec: SharedEvent = { ...r.rec, plan: res.state, updatedAt: now };
    const w = await s.store.cas(key(id), r.version, JSON.stringify(rec), EVENT_TTL_SEC);
    if (w.ok) { logServer("events", "join_requested", { id, pending: res.state.joinRequests.filter(x => x.status === "pending").length }); return JOIN_ACCEPTED(); }
  }
  return fail(409, "busy", "The event is being updated right now. Please try again.");
}
