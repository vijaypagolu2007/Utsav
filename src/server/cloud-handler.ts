// Signed-in cloud save: an organizer's own plans in Firestore at users/{uid}/plans/{planKey}.
//
// Framework-free (Web Request in, HandlerResult out) and dependency-injected, so it is unit-tested with a fake verifier
// and an in-memory repo. Separate from the shared guest-link routes (/api/events/*), which use organizer tokens.
// Keyless: no service account. The server only needs the public Firebase project id.
//   • Identity: `Authorization: Bearer <Firebase ID token>`, verified by the injected verifier (src/server/firebase-token.ts:
//     RS256 against Google's public keys, aud/iss = the project). The uid comes only from the verified token: request
//     bodies are strict and can't carry one. The same token is forwarded to Firestore, whose rules check it again.
//   • Every plan is validated with the full AgentState schema; invalid plans are rejected, never repaired.
//   • Versions are server-assigned; a save is a compare-and-set on `baseVersion` (0 = create). A stale save gets 409
//     with the current cloud copy so the client can ask the organizer which one to keep.
//   • Tokens are never logged, echoed or stored.
import { z } from "zod";
import { AgentState } from "@/schema";
import { fail, issuesOf, logServer, ok, readJsonLimited, type HandlerResult } from "./http";
import { limited, MAX_PLAN_BYTES } from "./events";
import { CloudUpstreamError, type Caller, type CloudDoc, type CloudRepo } from "./cloud-repo";
import type { EventStore } from "./store";

export const CLOUD_MAX_BODY_BYTES = 512 * 1024;
export { MAX_PLAN_BYTES as CLOUD_MAX_PLAN_BYTES };
/** Plan slots are template ids ("wedding", "birthday", …): short lowercase slugs, safe as a Firestore document id. */
export const PLAN_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A Firebase ID token is a JWT: three base64url segments. Anything else is refused before it reaches the verifier. */
const ID_TOKEN = /^[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,2048}$/;

export type VerifyToken = (idToken: string) => Promise<{ uid: string }>;
export type CloudDeps = {
  /** null when the public Firebase config (NEXT_PUBLIC_FIREBASE_*) is absent (→ 503). */
  verifyToken: VerifyToken | null;
  repo: CloudRepo | null;
  /** The shared store's rate limiter; null (no shared storage) means no rate limiting, not an outage. */
  store?: EventStore | null;
  now?: () => Date;
  log?: typeof logServer;
};

export const SaveRequest = z.object({ plan: z.unknown(), baseVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
/** v8 Part 0c: the tombstone write. No plan: the stored one is kept, so Restore (a normal save) works on any device. */
export const TombstoneRequest = z.object({ deleted: z.literal(true), baseVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

const NOT_CONFIGURED = () => fail(503, "cloud_not_configured", "Cloud save isn't set up on this server. Your plans are still saved on this device.");
const UNAUTHORIZED = () => fail(401, "unauthorized", "Sign in again to use cloud save");

/** The raw ID token from the Authorization header, or null. */
export function idTokenFrom(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer ([^\s]+)$/);
  return m && ID_TOKEN.test(m[1]!) ? m[1]! : null;
}

const ipOf = (request: Request) =>
  (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local").slice(0, 64);

type Authed = { ok: true; uid: string; caller: Caller; repo: CloudRepo } | { ok: false; result: HandlerResult };

async function authenticate(request: Request, deps: CloudDeps): Promise<Authed> {
  const log = deps.log ?? logServer;
  if (!deps.verifyToken || !deps.repo) return { ok: false, result: NOT_CONFIGURED() };
  if (deps.store) { const rl = await limited(deps.store, "cloudIp", ipOf(request)); if (rl) return { ok: false, result: rl }; }
  const token = idTokenFrom(request);
  if (!token) return { ok: false, result: UNAUTHORIZED() };
  let uid: string;
  try { uid = (await deps.verifyToken(token)).uid; }
  catch (e) {
    // Only the verifier's error code: a message could quote the token.
    const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code).slice(0, 80) : "verify_failed";
    log("cloud", "token_rejected", { code });
    return { ok: false, result: UNAUTHORIZED() };
  }
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return { ok: false, result: UNAUTHORIZED() };
  return { ok: true, uid, caller: { uid, idToken: token }, repo: deps.repo };
}

const docBody = (planKey: string, d: CloudDoc, plan: AgentState) => ({ planKey, version: d.version, updatedAt: d.updatedAt, plan, ...(d.deletedAt ? { deletedAt: d.deletedAt } : {}) });

/** A stored copy that no longer parses is treated as absent (never served half-parsed). */
function parseStored(d: CloudDoc | null): { doc: CloudDoc; plan: AgentState } | null {
  if (!d) return null;
  try {
    const p = AgentState.safeParse(JSON.parse(d.planJson));
    return p.success ? { doc: d, plan: p.data } : null;
  } catch { return null; }
}

/**
 * Firestore's answer as a clean API error. Upstream bodies are never forwarded; only the category is logged.
 * 401 → sign in again · 403 → the rules refused (wrong rules deployed, or a malformed stored document)
 * no database / unreachable → 502 (503 is reserved for "not configured", which the client treats as "cloud save is off").
 */
async function guarded(deps: CloudDeps, op: string, f: () => Promise<HandlerResult>): Promise<HandlerResult> {
  try { return await f(); }
  catch (e) {
    if (!(e instanceof CloudUpstreamError)) throw e;
    (deps.log ?? logServer)("cloud", "firestore_error", { op, kind: e.kind, status: e.httpStatus });
    if (e.kind === "unauthorized") return UNAUTHORIZED();
    if (e.kind === "forbidden") return fail(403, "cloud_forbidden", "The cloud database refused this request. Your plans are still saved on this device.");
    if (e.kind === "no_database") return fail(502, "cloud_not_ready", "Cloud save isn't ready yet (no database). Your plans are still saved on this device.");
    return fail(502, "cloud_unavailable", "Cloud save is unavailable right now. Your plans are still saved on this device.");
  }
}

/** GET /api/cloud/plans → { plans: [{ planKey, version, updatedAt, title, eventType }] } (no plan bodies). */
export async function handleCloudList(request: Request, deps: CloudDeps): Promise<HandlerResult> {
  const a = await authenticate(request, deps); if (!a.ok) return a.result;
  if (deps.store) { const rl = await limited(deps.store, "cloudRead", a.uid); if (rl) return rl; }
  return guarded(deps, "list", async () => ok({ plans: await a.repo.list(a.caller) }));
}

/** GET /api/cloud/plans/:planKey → { planKey, version, updatedAt, plan } or 404. */
export async function handleCloudGet(request: Request, planKey: string, deps: CloudDeps): Promise<HandlerResult> {
  const a = await authenticate(request, deps); if (!a.ok) return a.result;
  if (!PLAN_KEY.test(planKey)) return fail(400, "invalid_plan_key", "Unknown plan");
  if (deps.store) { const rl = await limited(deps.store, "cloudRead", a.uid); if (rl) return rl; }
  return guarded(deps, "get", async () => {
    const s = parseStored(await a.repo.get(a.caller, planKey));
    if (!s) return fail(404, "not_found", "No cloud copy of this plan yet");
    return ok(docBody(planKey, s.doc, s.plan));
  });
}

/** PUT /api/cloud/plans/:planKey { plan, baseVersion } → 200 { planKey, version, updatedAt } or 409 { current }. */
export async function handleCloudSave(request: Request, planKey: string, deps: CloudDeps): Promise<HandlerResult> {
  const a = await authenticate(request, deps); if (!a.ok) return a.result;
  if (!PLAN_KEY.test(planKey)) return fail(400, "invalid_plan_key", "Unknown plan");
  if (deps.store) { const rl = await limited(deps.store, "cloudWrite", a.uid); if (rl) return rl; }
  const body = await readJsonLimited(request, CLOUD_MAX_BODY_BYTES);
  if (!body.ok) return body.result;
  if (body.value && typeof body.value === "object" && "deleted" in body.value) return tombstone(a, planKey, body.value, deps);
  const req = SaveRequest.safeParse(body.value);
  if (!req.success) return fail(400, "invalid_request", "Expected { plan, baseVersion }", { issues: issuesOf(req.error.issues) });
  const p = AgentState.safeParse(req.data.plan);
  if (!p.success) return fail(400, "invalid_state", "The plan failed validation", { issues: issuesOf(p.error.issues) });
  const planJson = JSON.stringify(p.data);
  // UTF-8 bytes, not characters: keeps every stored document well inside Firestore's 1 MiB limit.
  if (Buffer.byteLength(planJson, "utf8") > MAX_PLAN_BYTES) return fail(413, "plan_too_large", "The plan is too large for cloud save");
  const updatedAt = (deps.now?.() ?? new Date()).toISOString();
  return guarded(deps, "save", async () => {
    const w = await a.repo.cas(a.caller, planKey, req.data.baseVersion, {
      planJson, updatedAt, title: p.data.event.title.slice(0, 200), eventType: p.data.event.eventType,
    });
    if (!w.ok) {
      const cur = parseStored(w.current);
      // currentVersion is always given, so "keep this device's plan" can replace even a stored copy that no longer parses.
      return fail(409, "version_conflict", "The cloud copy changed since this device last saved it", {
        current: cur ? docBody(planKey, cur.doc, cur.plan) : null, currentVersion: w.current?.version ?? 0,
      });
    }
    return ok({ planKey, version: w.version, updatedAt: w.updatedAt });
  });
}

const conflictWith = (planKey: string, current: CloudDoc | null, code = "version_conflict", message = "The cloud copy changed since this device last saved it") => {
  const cur = parseStored(current);
  return fail(409, code, message, { current: cur ? docBody(planKey, cur.doc, cur.plan) : null, currentVersion: current?.version ?? 0 });
};

/**
 * PUT /api/cloud/plans/:planKey { deleted: true, baseVersion } → 200 { version, updatedAt, deletedAt }. Marks the copy
 * deleted (a tombstone, version + 1) so other devices drop their copy instead of uploading it again. Compare-and-set
 * like a save; deleting an already deleted copy at its current version changes nothing.
 */
async function tombstone(a: Extract<Authed, { ok: true }>, planKey: string, raw: unknown, deps: CloudDeps): Promise<HandlerResult> {
  const req = TombstoneRequest.safeParse(raw);
  if (!req.success) return fail(400, "invalid_request", "Expected { deleted: true, baseVersion }", { issues: issuesOf(req.error.issues) });
  const updatedAt = (deps.now?.() ?? new Date()).toISOString();
  return guarded(deps, "tombstone", async () => {
    const cur = await a.repo.get(a.caller, planKey);
    if (!cur) return fail(404, "not_found", "No cloud copy of this plan");
    if (cur.version !== req.data.baseVersion) return conflictWith(planKey, cur);
    if (cur.deletedAt) return ok({ planKey, version: cur.version, updatedAt: cur.updatedAt, deletedAt: cur.deletedAt });
    const w = await a.repo.cas(a.caller, planKey, cur.version, { planJson: cur.planJson, updatedAt, title: cur.title, eventType: cur.eventType, deletedAt: updatedAt });
    if (!w.ok) return conflictWith(planKey, w.current);
    return ok({ planKey, version: w.version, updatedAt: w.updatedAt, deletedAt: updatedAt });
  });
}

/**
 * DELETE /api/cloud/plans/:planKey?baseVersion=n&eventId=… → 200 { deleted: true } ("Delete forever"). Owner-only like
 * every cloud route, and only for a tombstoned copy at that version (and of that event, when named): a live copy, or a
 * newer event that took the slot since, is never removed (409).
 */
export async function handleCloudDelete(request: Request, planKey: string, deps: CloudDeps): Promise<HandlerResult> {
  const a = await authenticate(request, deps); if (!a.ok) return a.result;
  if (!PLAN_KEY.test(planKey)) return fail(400, "invalid_plan_key", "Unknown plan");
  if (deps.store) { const rl = await limited(deps.store, "cloudWrite", a.uid); if (rl) return rl; }
  const q = new URL(request.url).searchParams;
  const rawVersion = q.get("baseVersion") ?? "";
  const baseVersion = /^[1-9]\d{0,15}$/.test(rawVersion) ? Number(rawVersion) : NaN;
  const eventId = q.get("eventId");
  if (!Number.isSafeInteger(baseVersion) || (eventId !== null && !EVENT_ID.test(eventId))) return fail(400, "invalid_request", "Expected ?baseVersion=<n>[&eventId=<id>]");
  return guarded(deps, "delete", async () => {
    const cur = await a.repo.get(a.caller, planKey);
    if (!cur) return fail(404, "not_found", "No cloud copy of this plan");
    if (!cur.deletedAt) return conflictWith(planKey, cur, "not_deleted", "Only a deleted event can be deleted forever");
    if (cur.version !== baseVersion) return conflictWith(planKey, cur);
    if (eventId !== null) {
      const s = parseStored(cur);
      if (s && s.plan.event.id !== eventId) return conflictWith(planKey, cur, "different_event", "The cloud copy is a different event now");
    }
    const w = await a.repo.remove(a.caller, planKey, baseVersion);
    if (!w.ok) return w.current ? conflictWith(planKey, w.current) : ok({ planKey, deleted: true });
    return ok({ planKey, deleted: true });
  });
}
