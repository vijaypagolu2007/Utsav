// v8 Part 2 (code-review fixes): AI route rate limits, the client IP, guest hardening on /api/chat, debounced plan
// saves, ids without a module counter, and the CopilotKit removal.
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
process.env.UTSAV_SILENT_LOGS = "1";
process.env.UTSAV_DISABLE_GEMINI = "1";
import { royalWedding } from "../presets";
import { RATE } from "../server/events";
import { clientIp } from "../server/http";
import { MemoryStore, setStoreForTests } from "../server/store";
import { handleChat } from "../server/chat-handler";
import { POST as chatRoute } from "../app/api/chat/route";
import { POST as planRoute } from "../app/api/plan/route";
import { POST as scanRoute } from "../app/api/scan-quote/route";
import { defaultStore, flushStore, hasPendingSave, historyOf, isFirstRun, loadStore, parseStore, saveStore, SAVE_DEBOUNCE_MS, STORAGE_KEY, type Store } from "../persistence";
import { hasMeaningfulLocalEdits, isPristineSample, mayCreateCloudCopy } from "../my-events";
import { forgetThisDevice } from "../signin";
import { newId } from "../components/planner/ids";

const req = (headers: Record<string, string>) => new Request("http://localhost/api/x", { headers });
let ipSeq = 0;
/** A fresh documentation-range address per test, so no counter is shared between tests. */
const freshIp = () => `203.0.113.${++ipSeq}`;

describe("clientIp: x-real-ip, then the rightmost x-forwarded-for hop, then local", () => {
  test("x-real-ip wins over x-forwarded-for", () => {
    assert.equal(clientIp(req({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "192.0.2.1, 192.0.2.2" })), "198.51.100.7");
  });
  test("the rightmost x-forwarded-for entry (the closest proxy hop), not the client-supplied leftmost", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "192.0.2.1, 192.0.2.2, 198.51.100.9" })), "198.51.100.9");
    assert.equal(clientIp(req({ "x-forwarded-for": "192.0.2.1" })), "192.0.2.1");
    assert.equal(clientIp(req({ "x-forwarded-for": " 192.0.2.1 ,198.51.100.3 , " })), "198.51.100.3", "blank trailing entries are skipped");
  });
  test("nothing usable → local; long values are capped", () => {
    assert.equal(clientIp(req({})), "local");
    assert.equal(clientIp(req({ "x-forwarded-for": " , ", "x-real-ip": "  " })), "local");
    assert.equal(clientIp(req({ "x-real-ip": "a".repeat(100) })).length, 64);
  });
  test("a client rotating the leftmost entry stays on one rate-limit key", () => {
    const keys = new Set([1, 2, 3].map(i => clientIp(req({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.20` }))));
    assert.deepEqual([...keys], ["198.51.100.20"]);
  });
  test("the cloud routes use the same clientIp", () => {
    assert.match(readFileSync(new URL("../server/cloud-handler.ts", import.meta.url), "utf8"), /const ipOf = clientIp;/);
  });
});

describe("AI routes are rate-limited per IP (429 with Retry-After)", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));
  const chatBody = JSON.stringify({ messages: [{ role: "user", text: "What is overdue?" }], state: royalWedding, today: "2026-10-21", forceOffline: true });
  const post = (route: (r: Request) => Promise<Response>, ip: string, body: string, headers: Record<string, string> = {}) =>
    route(new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body }));

  test("the scopes exist with per-minute windows", () => {
    assert.deepEqual(RATE.aiChat, { limit: 30, windowSec: 60 });
    assert.deepEqual(RATE.aiScan, { limit: 10, windowSec: 60 });
    assert.deepEqual(RATE.aiPlan, { limit: 5, windowSec: 60 });
  });
  test("/api/chat: the 31st call in a minute from one IP is 429 with Retry-After; another IP still gets answers", async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE.aiChat.limit; i++) assert.equal((await post(chatRoute, ip, chatBody)).status, 200, `call ${i + 1}`);
    const r = await post(chatRoute, ip, chatBody);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), String(RATE.aiChat.windowSec));
    assert.equal(((await r.json()) as { error: string }).error, "rate_limited");
    assert.equal((await post(chatRoute, freshIp(), chatBody)).status, 200);
  });
  test("/api/plan: 5 a minute, then 429 (counted before the body is read)", async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE.aiPlan.limit; i++) assert.notEqual((await post(planRoute, ip, "{}")).status, 429);
    const r = await post(planRoute, ip, "{}");
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
  });
  test("/api/scan-quote: 10 a minute, then 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE.aiScan.limit; i++) assert.notEqual((await post(scanRoute, ip, "{}")).status, 429);
    const r = await post(scanRoute, ip, "{}");
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
  });
  test("a rotated leftmost x-forwarded-for doesn't reset the count", async () => {
    const hop = freshIp();
    for (let i = 0; i < RATE.aiPlan.limit; i++) await post(planRoute, `10.1.1.${i}, ${hop}`, "{}");
    assert.equal((await post(planRoute, `10.9.9.9, ${hop}`, "{}")).status, 429);
  });
  test("without shared storage the routes still limit, on a per-instance in-memory counter", async () => {
    setStoreForTests(null);
    const prev = { ...process.env };
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL; process.env.UTSAV_STORE = "none";
    try {
      const ip = freshIp();
      for (let i = 0; i < RATE.aiPlan.limit; i++) assert.notEqual((await post(planRoute, ip, "{}")).status, 429);
      assert.equal((await post(planRoute, ip, "{}")).status, 429);
    } finally { process.env = prev; setStoreForTests(null); }
  });
});

describe("/api/chat guest hardening: guest credentials always mean role guest", () => {
  beforeEach(() => setStoreForTests(new MemoryStore()));
  afterEach(() => setStoreForTests(null));
  const base = { messages: [{ role: "user" as const, text: "When is the Sangeet?" }], state: royalWedding, today: "2026-10-21", forceOffline: true };
  test("role organizer with guest credentials is refused (403)", async () => {
    const r = await handleChat({ ...base, role: "organizer" }, { guestCredentials: true });
    assert.equal(r.status, 403);
    assert.equal((r.body as { error: string }).error, "not_allowed");
  });
  test("no role with guest credentials is answered as a guest (organizer-only requests are refused)", async () => {
    assert.equal((await handleChat({ ...base, ideas: {} }, { guestCredentials: true })).status, 403);
    assert.equal((await handleChat({ ...base, ideas: {} }, {})).status, 200, "the same request without guest credentials is the organizer's");
    assert.equal((await handleChat({ ...base, role: "guest" }, { guestCredentials: true })).status, 200);
  });
  test("the route reads X-Guest-Token and X-Device-Token", async () => {
    const send = (headers: Record<string, string>) => chatRoute(new Request("http://localhost/api/chat", { method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers }, body: JSON.stringify({ ...base, role: "organizer" }) }));
    assert.equal((await send({ "x-guest-token": "g".repeat(43) })).status, 403);
    assert.equal((await send({ "x-device-token": newId("d") })).status, 403);
    assert.equal((await send({})).status, 200, "the organizer's own chat is unchanged");
  });
});

describe("debounced plan saves (persistence.saveStore / flushStore)", () => {
  const items = new Map<string, string>();
  let writes = 0;
  const listeners: Record<string, (() => void)[]> = {};
  const docListeners: (() => void)[] = [];
  const doc = { visibilityState: "visible" as "visible" | "hidden", addEventListener: (_t: string, f: () => void) => { docListeners.push(f); } };
  const g = globalThis as { window?: unknown; document?: unknown };
  const prevWindow = g.window, prevDoc = g.document;
  const stored = () => parseStore(items.get(STORAGE_KEY) ?? null);
  const withToday = (d: string): Store => ({ ...defaultStore(), today: d });
  beforeEach(() => {
    g.window = { localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { writes++; items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } },
      addEventListener: (t: string, f: () => void) => { (listeners[t] ??= []).push(f); } };
    g.document = doc;
    mock.timers.enable({ apis: ["setTimeout"] });
    flushStore(); items.clear(); writes = 0;
  });
  afterEach(() => { mock.timers.reset(); g.window = prevWindow; g.document = prevDoc; });

  test("a burst of saves writes once, SAVE_DEBOUNCE_MS after the last one, with the newest store", () => {
    assert.equal(SAVE_DEBOUNCE_MS, 300);
    saveStore(withToday("2026-10-01"));
    mock.timers.tick(200);
    saveStore(withToday("2026-10-02"));
    mock.timers.tick(299);
    assert.equal(writes, 0);
    assert.equal(hasPendingSave(), true);
    mock.timers.tick(1);
    assert.equal(writes, 1);
    assert.equal(stored().today, "2026-10-02");
    assert.equal(hasPendingSave(), false);
    mock.timers.tick(1000);
    assert.equal(writes, 1, "nothing more to write");
  });
  test("flushStore writes the pending save at once (and only once)", () => {
    saveStore(withToday("2026-10-03"));
    assert.equal(flushStore(), true);
    assert.equal(stored().today, "2026-10-03");
    assert.equal(flushStore(), false);
    mock.timers.tick(1000);
    assert.equal(writes, 1);
  });
  test("pagehide, beforeunload and visibilitychange to hidden flush; becoming visible doesn't", () => {
    saveStore(withToday("2026-10-04"));
    for (const f of listeners.pagehide ?? []) f();
    assert.equal(stored().today, "2026-10-04");
    saveStore(withToday("2026-10-05"));
    for (const f of listeners.beforeunload ?? []) f();
    assert.equal(stored().today, "2026-10-05");
    saveStore(withToday("2026-10-06"));
    doc.visibilityState = "visible";
    for (const f of docListeners) f();
    assert.equal(stored().today, "2026-10-05");
    doc.visibilityState = "hidden";
    for (const f of docListeners) f();
    assert.equal(stored().today, "2026-10-06");
    assert.equal(writes, 3);
    assert.equal(listeners.pagehide?.length, 1, "listeners are added once");
  });
  test("no window (server render): saving is a no-op", () => {
    g.window = undefined;
    saveStore(withToday("2026-10-07"));
    assert.equal(hasPendingSave(), false);
    assert.equal(flushStore(), false);
  });
  test("the app flushes before anything reads storage back (sign-out removal, delete/restore, switching, cloud copies)", () => {
    const app = readFileSync(new URL("../components/PlannerApp.tsx", import.meta.url), "utf8");
    assert.match(app, /if \(removeFromDevice\) flushStore\(\);\n\s*if \(removeFromDevice\) forgetThisDevice\(\);/);
    assert.match(app, /push\(cloudPlan, "Loaded cloud copy"\); flushStore\(\);/);
    const trash = readFileSync(new URL("../components/planner/useEventTrash.ts", import.meta.url), "utf8");
    assert.equal(trash.match(/setStore\([^;]*, true\);/g)?.length, 3);
    const hist = readFileSync(new URL("../components/planner/usePlanHistory.ts", import.meta.url), "utf8");
    assert.match(hist, /const setStore = \(s: Store, now = false\) => \{ storeRef\.current = s; setStoreState\(s\); saveStore\(s\); if \(now\) flushStore\(\); \};/);
  });
});

describe("v8 Part 2 fix: an edit still in the debounce is what sign-in and every read-back see", () => {
  const items = new Map<string, string>();
  const g = globalThis as { window?: unknown; document?: unknown };
  const prevWindow = g.window, prevDoc = g.document;
  /** The wedding sample renamed, the way the E2E test edits it before signing in. */
  const editedSample = (): Store => {
    const s = defaultStore();
    const h = historyOf(s, "wedding");
    const plan = h.snaps[h.idx]!.plan;
    const edited = { ...plan, event: { ...plan.event, title: "My edited wedding" } };
    return { ...s, active: "wedding", byType: { ...s.byType, wedding: { snaps: [...h.snaps, { plan: edited, label: "Renamed" }], idx: h.snaps.length } } };
  };
  beforeEach(() => {
    g.window = { localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } },
      addEventListener: () => {} };
    g.document = { visibilityState: "visible", addEventListener: () => {} };
    mock.timers.enable({ apis: ["setTimeout"] });
    flushStore(); items.clear();
  });
  afterEach(() => { mock.timers.reset(); g.window = prevWindow; g.document = prevDoc; });

  test("edit, then an immediate sign-in decision (the planner remounting from /signin within the debounce) sees the edit", () => {
    saveStore(editedSample());
    assert.equal(hasPendingSave(), true, "still inside SAVE_DEBOUNCE_MS: nothing written yet");
    // The planner comes back from /signin and reads storage before the timer fires.
    const loaded = loadStore();
    const h = historyOf(loaded, "wedding");
    const plan = h.snaps[h.idx]!.plan;
    assert.equal(plan.event.title, "My edited wedding");
    assert.equal(hasMeaningfulLocalEdits(loaded), true, "no first sign-in chooser");
    assert.equal(isPristineSample("wedding", plan), false);
    assert.equal(mayCreateCloudCopy({ pristineSample: isPristineSample("wedding", plan), choice: null }), true, "the usual sync uploads it");
    assert.equal(hasPendingSave(), false, "the read flushed the save");
    // The old timer can't fire later and is not needed: storage already holds the edit.
    mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
    assert.equal(parseStore(items.get(STORAGE_KEY) ?? null).byType.wedding?.snaps.at(-1)?.plan.event.title, "My edited wedding");
  });
  test("isFirstRun counts a plan that is still waiting to be saved", () => {
    assert.equal(isFirstRun(), true);
    saveStore(editedSample());
    assert.equal(isFirstRun(), false);
  });
  test("\"Also remove this plan from this device\": a pending save is dropped and never lands after the removal", () => {
    saveStore(editedSample());
    forgetThisDevice();
    mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
    assert.equal(items.has(STORAGE_KEY), false);
    assert.equal(hasPendingSave(), false);
  });
  test("the planner flushes on unmount, and the sign-in link, the sign-in handlers and the cloud check flush first", () => {
    const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src("../components/planner/usePlanHistory.ts"), /useEffect\(\(\) => \(\) => \{ flushStore\(\); \}, \[\]\);/);
    assert.match(src("../components/AccountMenu.tsx"), /href=\{signInHref\(pathname\)\} onClick=\{\(\) => flushStore\(\)\}/);
    assert.match(src("../components/Welcome.tsx"), /href=\{SIGNIN_PATH\} onClick=\{\(\) => flushStore\(\)\}/);
    const signIn = src("../components/SignInPage.tsx");
    assert.equal(signIn.match(/flushStore\(\); markSignedInOnDevice\(\); router\.replace/g)?.length, 2);
    assert.match(src("../components/useCloudSync.ts"), /if \(!u\) return;\n(\s*\/\/.*\n)*\s*flushStore\(\);/);
    assert.match(src("../components/PlannerApp.tsx"), /if \(opening === "signin"\) \{ flushStore\(\); router\.replace/);
  });
});

describe("ids without a module counter", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  test("crypto.randomUUID when available: prefixed, unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId("m")));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id.slice(2), UUID_V4);
  });
  test("plain-http LAN origins (no randomUUID): a v4 UUID from getRandomValues; nothing at all: still unique", () => {
    const real = globalThis.crypto;
    const swap = (c: unknown) => Object.defineProperty(globalThis, "crypto", { value: c, configurable: true, writable: true });
    try {
      swap({ getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
      const a = newId("m"), b = newId("m");
      assert.match(a.slice(2), UUID_V4);
      assert.notEqual(a, b);
      swap(undefined);
      const c = newId("t"), d = newId("t");
      assert.ok(c.startsWith("t-") && c !== d);
    } finally { swap(real); }
  });
  test("PlannerApp and its hooks no longer keep a module-level id counter", () => {
    const app = readFileSync(new URL("../components/PlannerApp.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(app, /let uid = 0/);
    assert.doesNotMatch(app, /\+\+uid/);
  });
});

describe("CopilotKit is gone (it was never imported)", () => {
  test("no file, no dependency", () => {
    assert.equal(existsSync(new URL("../copilot-actions.tsx", import.meta.url)), false);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(k => k.startsWith("@copilotkit/")), []);
  });
});

describe("PlannerApp context value is memoized with stable handlers", () => {
  test("useMemo over the values it shows; functions from useStableHandlers", () => {
    const app = readFileSync(new URL("../components/PlannerApp.tsx", import.meta.url), "utf8");
    assert.match(app, /const handlers = useStableHandlers\(\{/);
    assert.match(app, /const ctx: PlannerState = useMemo\(\(\) => \(\{/);
    assert.ok(app.split("\n").length < 450, "PlannerApp stays under ~450 lines");
  });
});
