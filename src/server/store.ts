// Shared event storage. One small interface, three backends:
//   • UpstashStore: production. Upstash Redis REST API over fetch (no SDK dependency). Writes are atomic
//     compare-and-set via a Lua script, so concurrent writers can never silently overwrite each other.
//   • FileStore: local development and E2E only (a JSON file per event under .data/). Refuses to run on Vercel.
//   • MemoryStore: unit tests.
// Configure with UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or Vercel's KV_REST_API_URL + KV_REST_API_TOKEN).
import { promises as fs } from "node:fs";
import path from "node:path";

export type Versioned = { version: number; json: string };
export type CasResult = { ok: true; version: number } | { ok: false; conflict: true; current: Versioned | null };

export interface EventStore {
  readonly kind: "upstash" | "file" | "memory";
  get(key: string): Promise<Versioned | null>;
  /** Create only if absent. */
  create(key: string, json: string, ttlSec: number): Promise<boolean>;
  /** Write only if the stored version still equals `expectedVersion`; the new version is expected + 1. */
  cas(key: string, expectedVersion: number, json: string, ttlSec: number): Promise<CasResult>;
  /** Fixed-window counter for rate limiting. Returns the count after incrementing. */
  incr(key: string, windowSec: number): Promise<number>;
}

// ---------- memory (tests) ----------
export class MemoryStore implements EventStore {
  readonly kind = "memory" as const;
  private data = new Map<string, Versioned>();
  private counters = new Map<string, { n: number; until: number }>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async create(key: string, json: string) {
    if (this.data.has(key)) return false;
    this.data.set(key, { version: 1, json });
    return true;
  }
  async cas(key: string, expectedVersion: number, json: string): Promise<CasResult> {
    const cur = this.data.get(key) ?? null;
    if (!cur || cur.version !== expectedVersion) return { ok: false, conflict: true, current: cur };
    const next = { version: expectedVersion + 1, json };
    this.data.set(key, next);
    return { ok: true, version: next.version };
  }
  async incr(key: string, windowSec: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.until < now) { this.counters.set(key, { n: 1, until: now + windowSec * 1000 }); return 1; }
    c.n++;
    return c.n;
  }
}

// ---------- file (local dev / E2E) ----------
export class FileStore implements EventStore {
  readonly kind = "file" as const;
  private chain: Promise<unknown> = Promise.resolve();
  private counters = new Map<string, { n: number; until: number }>();
  constructor(private dir: string) {}
  /** Keys contain ":" (and rate-limit keys contain IPs), which Windows forbids in file names. Encode every character
   *  outside [A-Za-z0-9_-] as ~hh so names are valid on every OS and two keys can never map to the same file. */
  static fileName(key: string) { return `${key.replace(/[^A-Za-z0-9_-]/g, c => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}.json`; }
  private file(key: string) { return path.join(this.dir, FileStore.fileName(key)); }
  /** Serialise writes inside this process (next dev / next start is a single process). */
  private locked<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }
  async get(key: string): Promise<Versioned | null> {
    try { return JSON.parse(await fs.readFile(this.file(key), "utf8")) as Versioned; } catch { return null; }
  }
  private async write(key: string, v: Versioned) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(key)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(v), "utf8");
    await fs.rename(tmp, this.file(key));
  }
  create(key: string, json: string) {
    return this.locked(async () => {
      if (await this.get(key)) return false;
      await this.write(key, { version: 1, json });
      return true;
    });
  }
  cas(key: string, expectedVersion: number, json: string): Promise<CasResult> {
    return this.locked(async () => {
      const cur = await this.get(key);
      if (!cur || cur.version !== expectedVersion) return { ok: false as const, conflict: true as const, current: cur };
      await this.write(key, { version: expectedVersion + 1, json });
      return { ok: true as const, version: expectedVersion + 1 };
    });
  }
  async incr(key: string, windowSec: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.until < now) { this.counters.set(key, { n: 1, until: now + windowSec * 1000 }); return 1; }
    return ++c.n;
  }
}

// ---------- Upstash Redis REST (production) ----------
// Value layout: a Redis hash { v: <int version>, j: <json> } per event key.
const LUA_CREATE = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'v', 1, 'j', ARGV[1])
if tonumber(ARGV[2]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 1`;
const LUA_CAS = `local cur = redis.call('HGET', KEYS[1], 'v')
if not cur then return -1 end
if tonumber(cur) ~= tonumber(ARGV[1]) then return -2 end
local nv = tonumber(cur) + 1
redis.call('HSET', KEYS[1], 'v', nv, 'j', ARGV[2])
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return nv`;
const LUA_INCR = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class UpstashStore implements EventStore {
  readonly kind = "upstash" as const;
  constructor(private url: string, private token: string, private fetchFn: typeof fetch = fetch) {}
  private async cmd(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchFn(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args.map(String)),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || j.error) throw new Error(`Storage error (${res.status})`);
    return j.result;
  }
  async get(key: string): Promise<Versioned | null> {
    const r = (await this.cmd(["HMGET", key, "v", "j"])) as [string | null, string | null] | null;
    if (!r || r[0] === null || r[1] === null) return null;
    return { version: Number(r[0]), json: r[1] };
  }
  async create(key: string, json: string, ttlSec: number) {
    return Number(await this.cmd(["EVAL", LUA_CREATE, 1, key, json, ttlSec])) === 1;
  }
  async cas(key: string, expectedVersion: number, json: string, ttlSec: number): Promise<CasResult> {
    const r = Number(await this.cmd(["EVAL", LUA_CAS, 1, key, expectedVersion, json, ttlSec]));
    if (r > 0) return { ok: true, version: r };
    return { ok: false, conflict: true, current: await this.get(key) };
  }
  async incr(key: string, windowSec: number) {
    return Number(await this.cmd(["EVAL", LUA_INCR, 1, key, windowSec]));
  }
}

// ---------- selection ----------
export type StoreConfig = { store: EventStore | null; reason?: string };
let cached: StoreConfig | null = null;
let override: EventStore | null = null;

/** Tests inject a MemoryStore here. */
export function setStoreForTests(s: EventStore | null) { override = s; cached = null; }

export function getStore(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  if (override) return { store: override };
  if (cached) return cached;
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) {
    if (!/^https:\/\//.test(url)) return (cached = { store: null, reason: "UPSTASH_REDIS_REST_URL must be an https URL" });
    return (cached = { store: new UpstashStore(url, token) });
  }
  const mode = env.UTSAV_STORE?.trim() || undefined;
  const wantFile = mode === "file" || (mode === undefined && env.NODE_ENV !== "production");
  if (wantFile) {
    // A serverless filesystem is ephemeral and per-instance: never pretend it is shared storage.
    if (env.VERCEL) return (cached = { store: null, reason: "File storage is disabled on Vercel. Configure Upstash Redis." });
    return (cached = { store: new FileStore(path.resolve(/* turbopackIgnore: true */ process.cwd(), env.UTSAV_DATA_DIR || ".data")) });
  }
  return (cached = { store: null, reason: "Shared guest links need UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN" });
}
