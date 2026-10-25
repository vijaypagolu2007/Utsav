// v7 (keyless): optional Google sign-in + Firestore cloud save. Handlers run with a fake ID-token verifier and an
// in-memory repo; the real verifier is checked with tokens signed by a throwaway RSA key pair, and the Firestore REST
// repo against an in-test fake of the REST API. No Firebase project, network or key is needed. Also covers the client's
// sync decisions, the API client and firestore.rules (static checks, no emulator).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday } from "../presets";
import { applyBatch } from "../commands";
import { AgentState } from "../schema";
import { CLOUD_MAX_BODY_BYTES, handleCloudGet, handleCloudList, handleCloudSave, idTokenFrom, type CloudDeps } from "../server/cloud-handler";
import { CLOUD_DOC_FIELDS, CloudUpstreamError, FirestoreRestRepo, MemoryCloudRepo, fromFirestore } from "../server/cloud-repo";
import { makeTokenVerifier, TokenRejected } from "../server/firebase-token";
import { cloudDeps } from "../server/cloud-route";
import { MAX_PLAN_BYTES } from "../server/events";
import { PLAN_KEY } from "../server/cloud-handler";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { MemoryStore } from "../server/store";
import {
  canonicalJson, decideOnSignIn, fetchCloudCopy, keepLocalBaseVersion, planHash, saveCloudCopy, shouldAutosave, statusLabel, type CloudCopy, type SyncStatus,
} from "../cloud-sync";
import { firebaseClientConfig } from "../cloud-config";
import { signInErrorMessage } from "../components/cloud-auth";

// Fake JWT-shaped tokens (three base64url segments). Never real credentials.
const TOKEN_A = `${"a".repeat(20)}.${"userA".repeat(8)}.${"s".repeat(30)}`;
const TOKEN_B = `${"b".repeat(20)}.${"userB".repeat(8)}.${"t".repeat(30)}`;
const verifyToken = async (t: string) => {
  if (t === TOKEN_A) return { uid: "uid_A" };
  if (t === TOKEN_B) return { uid: "uid_B" };
  throw Object.assign(new Error(`Decoding Firebase ID token failed: ${t}`), { code: "auth/argument-error" });
};

function setup(extra: Partial<CloudDeps> = {}) {
  const logs: string[] = [];
  const repo = new MemoryCloudRepo();
  const deps: CloudDeps = {
    verifyToken, repo, store: new MemoryStore(), now: () => new Date("2026-10-23T10:00:00.000Z"),
    log: (scope, event, detail = {}) => { logs.push(`${scope} ${event} ${JSON.stringify(detail)}`); }, ...extra,
  };
  return { deps, repo, logs };
}
const req = (method: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/cloud/plans/wedding", {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const b = (r: { body: unknown }) => r.body as Record<string, unknown>;
const changed = (p: AgentState, title: string) => {
  const r = applyBatch(p, { summary: "rename", commands: [{ op: "rename_event", title }] }, { source: "ui" });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.state;
};

describe("cloud API: configuration and auth", () => {
  test("server without the public Firebase config → 503 on every route, before any token check", async () => {
    const { deps } = setup({ verifyToken: null, repo: null });
    for (const r of [await handleCloudList(req("GET", TOKEN_A), deps), await handleCloudGet(req("GET", null), "wedding", deps), await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps)]) {
      assert.equal(r.status, 503);
      assert.equal(b(r).error, "cloud_not_configured");
    }
  });
  test("missing, malformed or rejected ID token → 401", async () => {
    const { deps } = setup();
    assert.equal((await handleCloudList(req("GET", null), deps)).status, 401);
    assert.equal((await handleCloudList(req("GET", "not-a-jwt"), deps)).status, 401);
    assert.equal((await handleCloudList(req("GET", null, undefined, { authorization: `Basic ${TOKEN_A}` }), deps)).status, 401);
    const forged = `${"x".repeat(20)}.${"y".repeat(40)}.${"z".repeat(30)}`;
    const r = await handleCloudSave(req("PUT", forged, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.equal(r.status, 401);
    assert.equal(b(r).error, "unauthorized");
  });
  test("idTokenFrom accepts only a JWT-shaped bearer", () => {
    assert.equal(idTokenFrom(req("GET", TOKEN_A)), TOKEN_A);
    assert.equal(idTokenFrom(req("GET", "abc.def.ghi")), null);
    assert.equal(idTokenFrom(req("GET", null, undefined, { authorization: `Bearer ${TOKEN_A} extra` })), null);
  });
  test("tokens never reach the logs, even when the verifier's error quotes them", async () => {
    const { deps, logs } = setup();
    const forged = `${"q".repeat(20)}.${"leak".repeat(10)}.${"w".repeat(30)}`;
    await handleCloudList(req("GET", forged), deps);
    await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.ok(logs.length >= 1, "the rejection is logged");
    for (const l of logs) { assert.ok(!l.includes(forged) && !l.includes("leak"), l); assert.ok(!l.includes(TOKEN_A), l); }
    assert.match(logs[0]!, /token_rejected .*auth\/argument-error/);
  });
});

describe("cloud API: save, get, list", () => {
  test("first save creates version 1; get returns the validated plan; list has summaries only", async () => {
    const { deps } = setup();
    const s = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.equal(s.status, 200);
    assert.deepEqual(b(s), { planKey: "wedding", version: 1, updatedAt: "2026-10-23T10:00:00.000Z" });
    const g = await handleCloudGet(req("GET", TOKEN_A), "wedding", deps);
    assert.equal(g.status, 200);
    assert.equal(b(g).version, 1);
    assert.deepEqual(b(g).plan, AgentState.parse(royalWedding));
    const l = await handleCloudList(req("GET", TOKEN_A), deps);
    assert.deepEqual(b(l).plans, [{ planKey: "wedding", version: 1, updatedAt: "2026-10-23T10:00:00.000Z", title: royalWedding.event.title, eventType: "wedding" }]);
    assert.ok(!JSON.stringify(b(l)).includes("budgetItems"), "no plan bodies in the list");
  });
  test("versions are server-assigned and every save is compare-and-set (409 carries the current cloud copy)", async () => {
    const { deps } = setup();
    await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    const v2 = changed(royalWedding, "Second device edit");
    assert.equal(b(await handleCloudSave(req("PUT", TOKEN_A, { plan: v2, baseVersion: 1 }), "wedding", deps)).version, 2);
    // A device still on version 1 (or trying to create again) is refused with the current copy.
    for (const base of [1, 0, 7]) {
      const c = await handleCloudSave(req("PUT", TOKEN_A, { plan: changed(royalWedding, "Stale"), baseVersion: base }), "wedding", deps);
      assert.equal(c.status, 409);
      assert.equal(b(c).error, "version_conflict");
      const cur = b(c).current as { version: number; plan: AgentState };
      assert.equal(cur.version, 2);
      assert.equal(cur.plan.event.title, "Second device edit");
      assert.equal(b(c).currentVersion, 2);
    }
    // "Keep this device's plan" = save on the current version.
    assert.equal(b(await handleCloudSave(req("PUT", TOKEN_A, { plan: changed(royalWedding, "Kept"), baseVersion: 2 }), "wedding", deps)).version, 3);
  });
  test("invalid plans are rejected (400), never repaired; strict body (no uid or extra fields)", async () => {
    const { deps, repo } = setup();
    const bad = structuredClone(royalWedding) as unknown as { budgetItems: { plannedPaise: unknown }[] };
    bad.budgetItems[0]!.plannedPaise = 12.5;
    let r = await handleCloudSave(req("PUT", TOKEN_A, { plan: bad, baseVersion: 0 }), "wedding", deps);
    assert.equal(r.status, 400);
    assert.equal(b(r).error, "invalid_state");
    r = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0, uid: "uid_B" }), "wedding", deps);
    assert.equal(r.status, 400);
    r = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: -1 }), "wedding", deps);
    assert.equal(r.status, 400);
    r = await handleCloudSave(req("PUT", TOKEN_A, "{not json"), "wedding", deps);
    assert.equal(r.status, 400);
    r = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "../uid_B/plans/x", deps);
    assert.equal(r.status, 400);
    assert.equal(b(r).error, "invalid_plan_key");
    assert.equal(repo.docs.size, 0);
  });
  test("oversize: body over the cap → 413 without buffering it; a plan over the plan cap → 413", async () => {
    const { deps } = setup();
    const huge = JSON.stringify({ plan: royalWedding, baseVersion: 0, pad: "x".repeat(CLOUD_MAX_BODY_BYTES) });
    const r = await handleCloudSave(req("PUT", TOKEN_A, huge), "wedding", deps);
    assert.equal(r.status, 413);
    const big = structuredClone(royalWedding);
    big.event.title = "y".repeat(450 * 1024);
    const p = await handleCloudSave(req("PUT", TOKEN_A, { plan: big, baseVersion: 0 }), "wedding", deps);
    assert.ok(p.status === 413 || p.status === 400, `got ${p.status}`);
  });
  test("plan over the plan cap but inside the body cap → 413 plan_too_large", async () => {
    const { deps } = setup();
    const big = structuredClone(royalWedding) as AgentState;
    // Many valid tasks push the plan past 400 KB while the request stays under 512 KB.
    const t0 = big.tasks[0]!;
    big.tasks = Array.from({ length: 2100 }, (_, i) => ({ ...t0, id: `tx${i}`, title: `Task ${i} ${"z".repeat(60)}` }));
    const json = JSON.stringify({ plan: big, baseVersion: 0 });
    assert.ok(json.length < CLOUD_MAX_BODY_BYTES && json.length > 400 * 1024, `fixture is ${json.length} bytes`);
    const r = await handleCloudSave(req("PUT", TOKEN_A, json), "wedding", deps);
    assert.equal(r.status, 413);
    assert.equal(b(r).error, "plan_too_large");
  });
  test("uid isolation: one user's plans are invisible to another, whatever the body says", async () => {
    const { deps, repo } = setup();
    await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.deepEqual(b(await handleCloudList(req("GET", TOKEN_B), deps)).plans, []);
    assert.equal((await handleCloudGet(req("GET", TOKEN_B), "wedding", deps)).status, 404);
    // B saving the same slot creates B's own copy; A's is untouched.
    assert.equal((await handleCloudSave(req("PUT", TOKEN_B, { plan: arcadeBirthday, baseVersion: 0 }), "wedding", deps)).status, 200);
    assert.deepEqual([...repo.docs.keys()].sort(), ["uid_A/wedding", "uid_B/wedding"]);
    assert.equal((b(await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).plan as AgentState).event.title, royalWedding.event.title);
  });
  test("a stored copy that no longer validates is treated as missing (404), and can be replaced", async () => {
    const { deps, repo } = setup();
    repo.docs.set("uid_A/wedding", { version: 4, updatedAt: "x", planJson: "{\"broken\":true}", title: "", eventType: "" });
    assert.equal((await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).status, 404);
    const c = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.equal(c.status, 409);
    assert.equal(b(c).current, null);
    assert.equal(b(c).currentVersion, 4);
    assert.equal(b(await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 4 }), "wedding", deps)).version, 5);
  });
  test("rate limited per user (429 with retry-after)", async () => {
    const { deps } = setup();
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).status;
    assert.equal(last, 429);
    const r = await handleCloudGet(req("GET", TOKEN_A), "wedding", deps);
    assert.equal(r.headers?.["retry-after"], "60");
    // Another user has their own budget.
    assert.equal((await handleCloudGet(req("GET", TOKEN_B), "wedding", deps)).status, 404);
  });
});

// ---------- keyless ID-token verification (real jose, throwaway RSA keys) ----------
const PROJECT = "demo-proj";
const NOW = new Date(Date.UTC(2026, 9, 24, 10, 0, 0));
const NOW_S = Math.floor(NOW.getTime() / 1000);
async function keys() {
  const good = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { good, other, getKey: createLocalJWKSet({ keys: [jwk] }) };
}
type Claims = Record<string, unknown>;
const baseClaims = (): Claims => ({
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "uid_real", iat: NOW_S - 60, exp: NOW_S + 3000, auth_time: NOW_S - 120,
});
const sign = (key: CryptoKey, over: Claims = {}, kid = "k1") => {
  const c = { ...baseClaims(), ...over };
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  return new SignJWT(c as JWTPayload).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).sign(key);
};
async function rejectsWith(p: Promise<unknown>, code: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof TokenRejected && code.test(e.code) && !/eyJ/.test(e.message));
}

describe("ID-token verification (jose, Google securetoken JWKS shape)", () => {
  test("a valid token gives its sub as the uid", async () => {
    const k = await keys();
    const verify = makeTokenVerifier(PROJECT, { getKey: k.getKey, now: () => NOW });
    assert.deepEqual(await verify(await sign(k.good.privateKey)), { uid: "uid_real" });
    // A small clock skew is tolerated.
    assert.deepEqual(await verify(await sign(k.good.privateKey, { iat: NOW_S + 10, auth_time: NOW_S + 10 })), { uid: "uid_real" });
  });
  test("wrong audience, wrong issuer, expired, bad signature, unknown kid → rejected", async () => {
    const k = await keys();
    const verify = makeTokenVerifier(PROJECT, { getKey: k.getKey, now: () => NOW });
    await rejectsWith(verify(await sign(k.good.privateKey, { aud: "other-proj" })), /CLAIM_VALIDATION/);
    await rejectsWith(verify(await sign(k.good.privateKey, { iss: "https://securetoken.google.com/other-proj" })), /CLAIM_VALIDATION/);
    await rejectsWith(verify(await sign(k.good.privateKey, { iss: "https://accounts.google.com" })), /CLAIM_VALIDATION/);
    await rejectsWith(verify(await sign(k.good.privateKey, { exp: NOW_S - 120 })), /EXPIRED/);
    await rejectsWith(verify(await sign(k.other.privateKey)), /SIGNATURE/);
    await rejectsWith(verify(await sign(k.good.privateKey, {}, "unknown-kid")), /JWKS_NO_MATCHING_KEY/);
  });
  test("missing or oversized sub, future auth_time or iat, missing auth_time → rejected", async () => {
    const k = await keys();
    const verify = makeTokenVerifier(PROJECT, { getKey: k.getKey, now: () => NOW });
    await rejectsWith(verify(await sign(k.good.privateKey, { sub: undefined })), /CLAIM_VALIDATION/);
    await rejectsWith(verify(await sign(k.good.privateKey, { sub: "" })), /bad_sub/);
    await rejectsWith(verify(await sign(k.good.privateKey, { sub: "u".repeat(129) })), /bad_sub/);
    await rejectsWith(verify(await sign(k.good.privateKey, { auth_time: NOW_S + 600 })), /bad_auth_time/);
    await rejectsWith(verify(await sign(k.good.privateKey, { auth_time: undefined })), /CLAIM_VALIDATION/);
    await rejectsWith(verify(await sign(k.good.privateKey, { iat: NOW_S + 600 })), /bad_iat|CLAIM_VALIDATION/);
  });
  test("only RS256: an HS256 token (alg confusion) is refused", async () => {
    const k = await keys();
    const verify = makeTokenVerifier(PROJECT, { getKey: k.getKey, now: () => NOW });
    const hs = await new SignJWT(baseClaims() as JWTPayload).setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(new TextEncoder().encode("x".repeat(32)));
    await rejectsWith(verify(hs), /ALG|JWKS|NO_MATCHING/);
  });
  test("wired into the handler: a real token saves; a forged one is 401 and only its error code is logged", async () => {
    const k = await keys();
    const { deps, logs } = setup({ verifyToken: makeTokenVerifier(PROJECT, { getKey: k.getKey, now: () => NOW }) });
    const good = await sign(k.good.privateKey);
    const r = await handleCloudSave(req("PUT", good, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.equal(r.status, 200);
    const forged = await sign(k.other.privateKey, { sub: "uid_victim" });
    assert.equal((await handleCloudGet(req("GET", forged), "wedding", deps)).status, 401);
    assert.ok(logs.some(l => /token_rejected .*SIGNATURE/.test(l)));
    for (const l of logs) assert.ok(!l.includes(good) && !l.includes(forged) && !l.includes("eyJ"), l);
  });
});

// ---------- Firestore REST repo against an in-test fake of the REST API ----------
type FsFields = Record<string, Record<string, unknown>>;
function fakeFirestore(opts: { noDatabase?: boolean; force?: { http: number; status: string }; throwNetwork?: boolean } = {}) {
  const docs = new Map<string, { fields: FsFields; updateTime: string }>();
  const calls: { method: string; url: URL; auth: string; body?: { fields: FsFields } }[] = [];
  let tick = 0;
  let beforePatch: (() => void) | null = null;
  const prefix = `/v1/projects/${PROJECT}/databases/(default)/documents/`;
  const name = (path: string) => `projects/${PROJECT}/databases/(default)/documents/${path}`;
  const err = (http: number, status: string) => new Response(JSON.stringify({ error: { code: http, status, message: `UPSTREAM-SECRET detail for ${status}` } }), { status: http });
  const put = (path: string, fields: FsFields) => { const d = { fields, updateTime: new Date(Date.UTC(2026, 9, 24, 0, 0, ++tick)).toISOString() }; docs.set(path, d); return d; };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as { fields: FsFields } : undefined;
    calls.push({ method, url, auth: (init?.headers as Record<string, string>).authorization ?? "", body });
    if (opts.throwNetwork) throw new TypeError("fetch failed");
    if (opts.force) return err(opts.force.http, opts.force.status);
    if (opts.noDatabase) return err(404, "NOT_FOUND");
    const path = decodeURIComponent(url.pathname).slice(prefix.length);
    const seg = path.split("/");
    if (method === "GET" && seg.length === 3) {
      const mask = url.searchParams.getAll("mask.fieldPaths");
      const documents = [...docs].filter(([p]) => p.startsWith(`${path}/`)).map(([p, d]) => ({
        name: name(p), updateTime: d.updateTime, fields: Object.fromEntries(Object.entries(d.fields).filter(([f]) => !mask.length || mask.includes(f))),
      }));
      return new Response(JSON.stringify(documents.length ? { documents } : {}), { status: 200 });
    }
    const cur = docs.get(path);
    if (method === "GET") return cur ? new Response(JSON.stringify({ name: name(path), ...cur }), { status: 200 }) : err(404, "NOT_FOUND");
    if (method === "PATCH") {
      beforePatch?.(); beforePatch = null;
      const now = docs.get(path);
      if (url.searchParams.get("currentDocument.exists") === "false" && now) return err(409, "ALREADY_EXISTS");
      const ut = url.searchParams.get("currentDocument.updateTime");
      if (ut && (!now || now.updateTime !== ut)) return err(400, "FAILED_PRECONDITION");
      // Rules stand-in: create = version 1, update = current + 1.
      const v = Number(body!.fields.version!.integerValue);
      if (now ? v !== Number(now.fields.version?.integerValue) + 1 : v !== 1) return err(403, "PERMISSION_DENIED");
      return new Response(JSON.stringify({ name: name(path), ...put(path, body!.fields) }), { status: 200 });
    }
    return err(400, "INVALID_ARGUMENT");
  }) as typeof fetch;
  return { docs, calls, put, fetchImpl, onBeforePatch: (f: () => void) => { beforePatch = f; } };
}
const CALLER = { uid: "uid_A", idToken: TOKEN_A };
const data = (title = "T", updatedAt = NOW.toISOString()) => ({ planJson: JSON.stringify(AgentState.parse(royalWedding)), updatedAt, title, eventType: "wedding" });

describe("Firestore REST repo (keyless, the caller's own token)", () => {
  test("create: PATCH users/{uid}/plans/{key} with exists=false, the user's bearer, exactly the known fields", async () => {
    const fs = fakeFirestore();
    const repo = new FirestoreRestRepo(PROJECT, fs.fetchImpl);
    assert.deepEqual(await repo.cas(CALLER, "wedding", 0, data()), { ok: true, version: 1, updatedAt: NOW.toISOString() });
    const patch = fs.calls.find(c => c.method === "PATCH")!;
    assert.equal(patch.url.origin + decodeURIComponent(patch.url.pathname), `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/uid_A/plans/wedding`);
    assert.equal(patch.url.searchParams.get("currentDocument.exists"), "false");
    assert.equal(patch.auth, `Bearer ${TOKEN_A}`);
    const f = fs.docs.get("users/uid_A/plans/wedding")!.fields;
    assert.deepEqual(Object.keys(f).sort(), [...CLOUD_DOC_FIELDS].sort());
    assert.equal(f.version!.integerValue, "1");
    assert.equal(typeof f.plan!.stringValue, "string");
    assert.equal(f.updatedAt!.timestampValue, NOW.toISOString());
    assert.equal(f.schema!.integerValue, "1");
    const got = await repo.get(CALLER, "wedding");
    assert.equal(got?.version, 1);
    assert.deepEqual(JSON.parse(got!.planJson), AgentState.parse(royalWedding));
  });
  test("update: compare-and-set on version + updateTime precondition; stale versions never PATCH", async () => {
    const fs = fakeFirestore();
    const repo = new FirestoreRestRepo(PROJECT, fs.fetchImpl);
    await repo.cas(CALLER, "wedding", 0, data());
    const ut = fs.docs.get("users/uid_A/plans/wedding")!.updateTime;
    assert.equal((await repo.cas(CALLER, "wedding", 1, data("Second"))).ok, true);
    const patch = fs.calls.filter(c => c.method === "PATCH")[1]!;
    assert.equal(patch.url.searchParams.get("currentDocument.updateTime"), ut);
    assert.equal(fs.docs.get("users/uid_A/plans/wedding")!.fields.version!.integerValue, "2");
    const before = fs.calls.length;
    const stale = await repo.cas(CALLER, "wedding", 1, data("Stale"));
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.current?.version, 2);
    assert.ok(fs.calls.slice(before).every(c => c.method === "GET"), "no write on a stale version");
  });
  test("409 mapping: ALREADY_EXISTS on create and FAILED_PRECONDITION in a race both become a conflict with the current copy", async () => {
    const fs = fakeFirestore();
    const repo = new FirestoreRestRepo(PROJECT, fs.fetchImpl);
    await repo.cas(CALLER, "wedding", 0, data());
    const again = await repo.cas(CALLER, "wedding", 0, data("Other device"));
    assert.ok(!again.ok && again.current?.version === 1);
    // Another device writes between our read and our PATCH.
    fs.onBeforePatch(() => { const d = fs.docs.get("users/uid_A/plans/wedding")!; fs.put("users/uid_A/plans/wedding", { ...d.fields, version: { integerValue: "2" } }); });
    const race = await repo.cas(CALLER, "wedding", 1, data("Mine"));
    assert.ok(!race.ok && race.current?.version === 2);
    // Through the handler: 409 version_conflict with the current copy.
    const { deps } = setup({ repo });
    const r = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 1 }), "wedding", deps);
    assert.equal(r.status, 409);
    assert.equal(b(r).error, "version_conflict");
    assert.equal(b(r).currentVersion, 2);
  });
  test("list: summaries only (field mask), sorted, per user; NOT_FOUND (no database yet) → empty list / no copy", async () => {
    const fs = fakeFirestore();
    const repo = new FirestoreRestRepo(PROJECT, fs.fetchImpl);
    await repo.cas(CALLER, "wedding", 0, data("W"));
    await repo.cas(CALLER, "birthday", 0, { ...data("B"), eventType: "birthday" });
    await repo.cas({ uid: "uid_B", idToken: TOKEN_B }, "wedding", 0, data("Theirs"));
    const l = await repo.list(CALLER);
    assert.deepEqual(l.map(p => [p.planKey, p.version, p.title]), [["birthday", 1, "B"], ["wedding", 1, "W"]]);
    assert.equal(l[0]!.updatedAt, NOW.toISOString());
    const listCall = fs.calls.filter(c => c.method === "GET" && c.url.pathname.endsWith("/plans")).pop()!;
    assert.deepEqual(listCall.url.searchParams.getAll("mask.fieldPaths").sort(), ["eventType", "title", "updatedAt", "version"]);
    assert.ok(!JSON.stringify(l).includes("budgetItems"));
    assert.deepEqual(await repo.list({ uid: "uid_C", idToken: TOKEN_A }), []);
    const none = new FirestoreRestRepo(PROJECT, fakeFirestore({ noDatabase: true }).fetchImpl);
    assert.deepEqual(await none.list(CALLER), []);
    assert.equal(await none.get(CALLER, "wedding"), null);
    await assert.rejects(none.cas(CALLER, "wedding", 0, data()), (e: unknown) => e instanceof CloudUpstreamError && e.kind === "no_database");
    const { deps } = setup({ repo: none });
    assert.deepEqual(b(await handleCloudList(req("GET", TOKEN_A), deps)).plans, []);
    assert.equal((await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).status, 404);
    const s = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
    assert.equal(s.status, 502);
    assert.equal(b(s).error, "cloud_not_ready");
  });
  test("a hand-written invalid document is rejected safely: never served, never crashes", async () => {
    const fs = fakeFirestore();
    const repo = new FirestoreRestRepo(PROJECT, fs.fetchImpl);
    const { deps } = setup({ repo });
    // Not one of ours (no integer version): treated as absent.
    fs.put("users/uid_A/plans/wedding", { plan: { stringValue: "{}" }, version: { stringValue: "7" } });
    assert.equal(await repo.get(CALLER, "wedding"), null);
    assert.equal((await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).status, 404);
    // Versioned but the plan isn't valid JSON / fails the schema: 404 on read, 409 with currentVersion on save.
    for (const plan of ["not json {", JSON.stringify({ broken: true }), JSON.stringify({ ...royalWedding, budgetItems: "nope" })]) {
      fs.put("users/uid_A/plans/wedding", { plan: { stringValue: plan }, version: { integerValue: "4" }, updatedAt: { timestampValue: NOW.toISOString() } });
      assert.equal((await handleCloudGet(req("GET", TOKEN_A), "wedding", deps)).status, 404);
      const c = await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps);
      assert.equal(c.status, 409);
      assert.equal(b(c).current, null);
      assert.equal(b(c).currentVersion, 4);
    }
    assert.equal(b(await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 4 }), "wedding", deps)).version, 5);
    assert.equal(fromFirestore({ fields: { plan: { stringValue: "{}" }, version: { integerValue: "0" } } }), null);
    assert.equal(fromFirestore(null), null);
    assert.equal(fromFirestore({}), null);
  });
  test("upstream errors map cleanly (401 / 403 / 502) and never leak Firestore's body to the client or the logs", async () => {
    const cases: [ReturnType<typeof fakeFirestore>, number, string][] = [
      [fakeFirestore({ force: { http: 401, status: "UNAUTHENTICATED" } }), 401, "unauthorized"],
      [fakeFirestore({ force: { http: 403, status: "PERMISSION_DENIED" } }), 403, "cloud_forbidden"],
      [fakeFirestore({ force: { http: 500, status: "INTERNAL" } }), 502, "cloud_unavailable"],
      [fakeFirestore({ force: { http: 429, status: "RESOURCE_EXHAUSTED" } }), 502, "cloud_unavailable"],
      [fakeFirestore({ throwNetwork: true }), 502, "cloud_unavailable"],
    ];
    for (const [fs, status, error] of cases) {
      const { deps, logs } = setup({ repo: new FirestoreRestRepo(PROJECT, fs.fetchImpl) });
      for (const r of [
        await handleCloudList(req("GET", TOKEN_A), deps),
        await handleCloudGet(req("GET", TOKEN_A), "wedding", deps),
        await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 0 }), "wedding", deps),
        await handleCloudSave(req("PUT", TOKEN_A, { plan: royalWedding, baseVersion: 3 }), "wedding", deps),
      ]) {
        assert.equal(r.status, status, `${error}: ${JSON.stringify(r.body)}`);
        assert.equal(b(r).error, error);
        assert.ok(!JSON.stringify(r.body).includes("UPSTREAM-SECRET"), "no upstream body in the response");
      }
      for (const l of logs) assert.ok(!l.includes("UPSTREAM-SECRET") && !l.includes(TOKEN_A), l);
      assert.ok(logs.some(l => l.includes("firestore_error")));
    }
  });
});

describe("configuration", () => {
  test("cloudDeps: 503 when the public config is absent or the project id is malformed; keyless deps otherwise", async () => {
    for (const cfg of [null, { apiKey: "k", authDomain: "d", projectId: "Bad Id!", appId: "a" }]) {
      const deps = cloudDeps(cfg);
      assert.equal(deps.verifyToken, null);
      const r = await handleCloudList(req("GET", TOKEN_A), deps);
      assert.equal(r.status, 503);
      assert.equal(b(r).error, "cloud_not_configured");
    }
    const deps = cloudDeps({ apiKey: "k", authDomain: "demo-proj.firebaseapp.com", projectId: "demo-proj", appId: "a" });
    assert.equal(typeof deps.verifyToken, "function");
    assert.ok(deps.repo instanceof FirestoreRestRepo);
  });
  test("client config needs all four NEXT_PUBLIC_FIREBASE_* values, else sign-in is hidden", () => {
    assert.equal(firebaseClientConfig({}), null);
    assert.equal(firebaseClientConfig({ NEXT_PUBLIC_FIREBASE_API_KEY: "k", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "d", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p" }), null);
    assert.deepEqual(firebaseClientConfig({ NEXT_PUBLIC_FIREBASE_API_KEY: "k", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "d", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p", NEXT_PUBLIC_FIREBASE_APP_ID: "a" }),
      { apiKey: "k", authDomain: "d", projectId: "p", appId: "a" });
  });
  test("COOP allows the Firebase sign-in popup; no firebase-admin anywhere (keyless)", () => {
    const next = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
    assert.match(next, /"Cross-Origin-Opener-Policy", value: "same-origin-allow-popups"/);
    assert.doesNotMatch(next, /firebase-admin/);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies["firebase-admin"], undefined);
    assert.ok(pkg.dependencies.jose, "jose verifies ID tokens");
  });
  test("firestore.rules: owner-only plans, exact fields, size cap, version + 1, same key pattern, no deletes, rest denied", () => {
    const raw = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
    const rules = raw.replace(/\/\/.*$/gm, "");
    assert.match(rules, /rules_version = '2';/);
    assert.match(rules, /match \/users\/\{uid\}\/plans\/\{planKey\} \{/);
    assert.match(rules, /request\.auth != null && request\.auth\.uid == uid/);
    const hasOnly = rules.match(/keys\(\)\.hasOnly\(\[([^\]]*)\]\)/);
    assert.ok(hasOnly, "hasOnly field list");
    assert.deepEqual(hasOnly[1]!.split(",").map(x => x.trim().replace(/'/g, "")).sort(), [...CLOUD_DOC_FIELDS].sort());
    assert.match(rules, new RegExp(`d\\.plan is string && d\\.plan\\.size\\(\\) <= ${MAX_PLAN_BYTES}\\b`));
    assert.match(rules, /d\.version is int/);
    assert.match(rules, /allow create: if isOwner\(\) && validKey\(\) && validShape\(request\.resource\.data\)\s+&& request\.resource\.data\.version == 1;/);
    assert.match(rules, /allow update: if isOwner\(\) && validKey\(\) && validShape\(request\.resource\.data\)[\s\S]*?request\.resource\.data\.version == resource\.data\.version \+ 1;/);
    assert.ok(rules.includes(`planKey.matches('${PLAN_KEY.source}')`), "rules use the server's plan key pattern");
    assert.match(rules, /allow read: if isOwner\(\);/);
    assert.match(rules, /allow delete: if false;/);
    assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    assert.doesNotMatch(rules, /if true|allow write: if isOwner|allow read, write: if isOwner/);
  });
  test("no Firebase config values are committed: .env.example placeholders are empty and no AIza key appears anywhere", () => {
    const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    for (const v of ["NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_APP_ID"])
      assert.match(env, new RegExp(`^${v}=$`, "m"), `${v} must be an empty placeholder`);
    // Keyless: no service-account variables anywhere in the config surface.
    for (const f of ["../../.env.example", "../../playwright.config.ts", "../../README.md", "../../docs/TECHNICAL.md", "../server/cloud-route.ts", "../server/firebase-token.ts", "../server/cloud-repo.ts"])
      assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /(?<!NEXT_PUBLIC_)FIREBASE_(PROJECT_ID|CLIENT_EMAIL|PRIVATE_KEY)\b|process\.env\.FIREBASE_/, f);
    for (const f of ["../../.env.example", "../../firestore.rules", "../../next.config.ts", "../cloud-config.ts", "../components/cloud-auth.ts", "../server/firebase-token.ts", "../server/cloud-repo.ts"])
      assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /AIza[0-9A-Za-z_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY-----\s*\n?[A-Za-z0-9+/]{20,}/);
  });
  test("sign-in popup errors become plain sentences; closing the popup says nothing", () => {
    assert.equal(signInErrorMessage("auth/popup-closed-by-user"), null);
    assert.match(signInErrorMessage("auth/popup-blocked")!, /pop-ups/);
    assert.match(signInErrorMessage("auth/unauthorized-domain")!, /authorized domains/);
    assert.match(signInErrorMessage("weird")!, /try again/);
  });
});

describe("sync decisions (client)", () => {
  const copy = (plan: AgentState, version: number): CloudCopy => ({ plan, version, updatedAt: "2026-10-23T10:00:00.000Z" });
  test("no cloud copy → create; identical → in sync", () => {
    assert.deepEqual(decideOnSignIn(royalWedding, null, null), { kind: "create" });
    assert.deepEqual(decideOnSignIn(royalWedding, copy(AgentState.parse(royalWedding), 3), null), { kind: "in_sync", version: 3 });
  });
  test("cloud differs and this device never synced it → choose (never picks the cloud copy on its own)", () => {
    assert.deepEqual(decideOnSignIn(royalWedding, copy(changed(royalWedding, "Other device"), 2), null), { kind: "choose" });
  });
  test("cloud is exactly what this device last saved and only the device changed → push on that version", () => {
    const local = changed(royalWedding, "Edited offline");
    assert.deepEqual(decideOnSignIn(local, copy(royalWedding, 4), { version: 4, hash: planHash(royalWedding) }), { kind: "push", baseVersion: 4 });
  });
  test("cloud moved on since this device's last save → choose, even with a base", () => {
    const local = changed(royalWedding, "Edited here");
    assert.deepEqual(decideOnSignIn(local, copy(changed(royalWedding, "Edited there"), 5), { version: 4, hash: planHash(royalWedding) }), { kind: "choose" });
  });
  test("planHash ignores key order and schema defaults; differs on any real change", () => {
    const reordered = JSON.parse(canonicalJson(royalWedding)) as AgentState;
    assert.equal(planHash(reordered), planHash(royalWedding));
    assert.equal(planHash(AgentState.parse(JSON.parse(JSON.stringify(royalWedding)))), planHash(royalWedding));
    assert.notEqual(planHash(changed(royalWedding, "x")), planHash(royalWedding));
    assert.equal(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] }), '{"a":[1,{"c":2}],"b":1}');
  });
  test("autosave only when signed in, nothing pending, and the plan differs from the last saved copy", () => {
    const base = { version: 2, hash: planHash(royalWedding) };
    const saved: SyncStatus = { state: "saved", at: 1 };
    assert.equal(shouldAutosave(saved, royalWedding, base), false);
    assert.equal(shouldAutosave(saved, changed(royalWedding, "new"), base), true);
    assert.equal(shouldAutosave(saved, royalWedding, null), true);
    for (const s of [{ state: "signed_out" }, { state: "checking" }, { state: "saving" }, { state: "choose", cloud: copy(royalWedding, 2), reason: "conflict" }] as SyncStatus[])
      assert.equal(shouldAutosave(s, changed(royalWedding, "new"), base), false, s.state);
  });
  test("keep this device's plan saves on the cloud's current version; status labels", () => {
    assert.equal(keepLocalBaseVersion(copy(royalWedding, 9)), 9);
    assert.equal(keepLocalBaseVersion(null, 4), 4);
    assert.equal(statusLabel({ state: "saved", at: 1 }), "Saved to cloud");
    assert.equal(statusLabel({ state: "saving" }), "Saving…");
    assert.equal(statusLabel({ state: "offline" }), "Offline – saved on this device");
    assert.match(statusLabel({ state: "choose", cloud: copy(royalWedding, 1), reason: "conflict" }), /changed elsewhere/);
  });
});

describe("cloud API client", () => {
  const fakeFetch = (status: number, body: unknown, seen?: RequestInit[]) =>
    (async (_u: unknown, init?: RequestInit) => { seen?.push(init!); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  test("sends the bearer token and maps 200 / 404 / 409 / 401 / 503 / network failure", async () => {
    const seen: RequestInit[] = [];
    const ok = await saveCloudCopy("wedding", TOKEN_A, royalWedding, 3, fakeFetch(200, { version: 4, updatedAt: "t" }, seen));
    assert.deepEqual(ok, { kind: "ok", version: 4, updatedAt: "t" });
    assert.equal((seen[0]!.headers as Record<string, string>).authorization, `Bearer ${TOKEN_A}`);
    assert.deepEqual(JSON.parse(String(seen[0]!.body)), { plan: JSON.parse(JSON.stringify(royalWedding)), baseVersion: 3 });
    assert.deepEqual(await fetchCloudCopy("wedding", TOKEN_A, fakeFetch(404, {})), { kind: "copy", copy: null });
    const got = await fetchCloudCopy("wedding", TOKEN_A, fakeFetch(200, { version: 2, updatedAt: "u", plan: royalWedding }));
    assert.equal(got.kind === "copy" && got.copy?.version, 2);
    const c = await saveCloudCopy("wedding", TOKEN_A, royalWedding, 1, fakeFetch(409, { current: { version: 5, updatedAt: "u", plan: arcadeBirthday }, currentVersion: 5 }));
    assert.ok(c.kind === "conflict" && c.current?.version === 5 && c.currentVersion === 5);
    assert.equal((await fetchCloudCopy("wedding", TOKEN_A, fakeFetch(401, {}))).kind, "unauthorized");
    assert.equal((await fetchCloudCopy("wedding", TOKEN_A, fakeFetch(503, { message: "no" }))).kind, "unavailable");
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    assert.equal((await saveCloudCopy("wedding", TOKEN_A, royalWedding, 1, offline)).kind, "offline");
  });
  test("a cloud copy that fails the schema on arrival is not used", async () => {
    const r = await fetchCloudCopy("wedding", TOKEN_A, fakeFetch(200, { version: 2, updatedAt: "u", plan: { nope: true } }));
    assert.equal(r.kind, "error");
  });
});

describe("Firebase SDK install", () => {
  // Regression: a second copy of @firebase/app (firebase pinned one version, @firebase/auth used another) made
  // getAuth throw "Component auth has not been registered yet", which silently hid the Sign in button.
  test("firebase/app and firebase/auth share one @firebase/app, so getAuth works", async () => {
    const { initializeApp, deleteApp } = await import("firebase/app");
    const { getAuth } = await import("firebase/auth");
    const app = initializeApp({ apiKey: "test-key", authDomain: "test.firebaseapp.com", projectId: "test", appId: "1:1:web:1" }, "sdk-install-check");
    try { assert.ok(getAuth(app)); } finally { await deleteApp(app); }
  });
});

describe("modal dialogs under React Strict Mode", () => {
  // Regression: in dev, Strict Mode re-runs the open effect; the cleanup's close() queued a "close" event that closed the
  // freshly re-opened dialog, so "Choose a version" (and Guest links) flashed shut. onClose must ignore that stale event.
  for (const file of ["src/components/AccountMenu.tsx", "src/components/ShareDialog.tsx"]) {
    test(`${file} ignores a close event while the dialog is open again`, () => {
      assert.match(readFileSync(file, "utf8"), /onClose=\{\(\) => \{ if \(!ref\.current\?\.open\) onClose\(\); \}\}/);
    });
  }
});
