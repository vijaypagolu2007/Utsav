// Cloud plan storage for signed-in organizers: users/{uid}/plans/{planKey}. One small interface, two backends:
//   • FirestoreRestRepo: production, keyless. It calls the Firestore REST API v1 with the organizer's *own* Firebase ID
//     token (`Authorization: Bearer`), so Firestore applies firestore.rules to every request (owner-only, field and
//     version checks). The server holds no service account and no secret.
//   • MemoryCloudRepo: unit tests.
// The plan is stored as one JSON string (Firestore rejects nested arrays and undefined values, and a string keeps the
// stored copy byte-for-byte what Zod validated). The version is assigned by the server, never taken from the client,
// and every write is a compare-and-set: a `version` field plus a Firestore precondition (`currentDocument.exists=false`
// to create, `currentDocument.updateTime` to update), with the rules enforcing version + 1 as a second guard.

export type CloudDoc = { version: number; updatedAt: string; planJson: string; title: string; eventType: string };
export type CloudSummary = { planKey: string; version: number; updatedAt: string; title: string; eventType: string };
/** `expectedVersion` 0 means "create: only if absent". The new version is expected + 1. */
export type CloudCasResult = { ok: true; version: number; updatedAt: string } | { ok: false; current: CloudDoc | null };
/** Who is asking: the uid from the verified token, and that same token (the REST backend forwards it to Firestore). */
export type Caller = { uid: string; idToken: string };

export interface CloudRepo {
  list(caller: Caller): Promise<CloudSummary[]>;
  get(caller: Caller, planKey: string): Promise<CloudDoc | null>;
  cas(caller: Caller, planKey: string, expectedVersion: number, data: Omit<CloudDoc, "version">): Promise<CloudCasResult>;
}

/**
 * Firestore said no, or couldn't be reached. Carries only a category: upstream bodies are never kept or forwarded.
 *   unauthorized → the ID token was refused · forbidden → the rules refused · no_database → Firestore isn't created yet
 *   unavailable → network failure, timeout, quota or a 5xx
 */
export class CloudUpstreamError extends Error {
  constructor(readonly kind: "unauthorized" | "forbidden" | "no_database" | "unavailable", readonly httpStatus = 0) {
    super(`Firestore request failed (${kind}${httpStatus ? ` ${httpStatus}` : ""})`);
    this.name = "CloudUpstreamError";
  }
}

// ---------- memory (tests) ----------
export class MemoryCloudRepo implements CloudRepo {
  readonly docs = new Map<string, CloudDoc>();
  private k(uid: string, planKey: string) { return `${uid}/${planKey}`; }
  async list({ uid }: Caller) {
    const out: CloudSummary[] = [];
    for (const [k, d] of this.docs) if (k.startsWith(`${uid}/`)) out.push({ planKey: k.slice(uid.length + 1), version: d.version, updatedAt: d.updatedAt, title: d.title, eventType: d.eventType });
    return out.sort((a, b) => a.planKey.localeCompare(b.planKey));
  }
  async get({ uid }: Caller, planKey: string) { return this.docs.get(this.k(uid, planKey)) ?? null; }
  async cas({ uid }: Caller, planKey: string, expectedVersion: number, data: Omit<CloudDoc, "version">): Promise<CloudCasResult> {
    const cur = this.docs.get(this.k(uid, planKey)) ?? null;
    if ((cur?.version ?? 0) !== expectedVersion) return { ok: false, current: cur };
    const next = { ...data, version: expectedVersion + 1 };
    this.docs.set(this.k(uid, planKey), next);
    return { ok: true, version: next.version, updatedAt: next.updatedAt };
  }
}

// ---------- Firestore REST v1 (production) ----------
/** The fields each plan document holds. firestore.rules allows exactly these keys (keys().hasOnly). */
export const CLOUD_DOC_FIELDS = ["plan", "version", "updatedAt", "title", "eventType", "schema"] as const;

type FsValue = { stringValue?: string; integerValue?: string | number; timestampValue?: string; [k: string]: unknown };
type FsDoc = { name?: string; fields?: Record<string, FsValue>; updateTime?: string };

const str = (v: FsValue | undefined) => (typeof v?.stringValue === "string" ? v.stringValue : "");
const int = (v: FsValue | undefined): number | null => {
  const n = typeof v?.integerValue === "string" ? Number(v.integerValue) : typeof v?.integerValue === "number" ? v.integerValue : NaN;
  return Number.isSafeInteger(n) ? n : null;
};
const time = (v: FsValue | undefined) => {
  const t = typeof v?.timestampValue === "string" ? Date.parse(v.timestampValue) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : str(v);
};

/** A stored document as a CloudDoc, or null when it isn't one of ours (no integer version or no plan string). */
export function fromFirestore(doc: FsDoc | null | undefined): CloudDoc | null {
  const f = doc?.fields;
  if (!f || typeof f !== "object") return null;
  const version = int(f.version);
  if (version === null || version < 1 || typeof f.plan?.stringValue !== "string") return null;
  return { version, updatedAt: time(f.updatedAt), planJson: f.plan.stringValue, title: str(f.title), eventType: str(f.eventType) };
}

export function toFirestoreFields(d: CloudDoc): Record<string, FsValue> {
  return {
    plan: { stringValue: d.planJson },
    version: { integerValue: String(d.version) },
    updatedAt: { timestampValue: d.updatedAt },
    title: { stringValue: d.title },
    eventType: { stringValue: d.eventType },
    schema: { integerValue: "1" },
  };
}

type Fetch = typeof fetch;

export class FirestoreRestRepo implements CloudRepo {
  private readonly base: string;
  constructor(projectId: string, private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 10_000) {
    this.base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  }
  private col(uid: string) { return `${this.base}/users/${encodeURIComponent(uid)}/plans`; }
  private docUrl(uid: string, planKey: string) { return `${this.col(uid)}/${encodeURIComponent(planKey)}`; }

  /** One request. Returns status, the upstream status word (errors only) and the parsed JSON; never throws on HTTP errors. */
  private async send(url: string, idToken: string, init: RequestInit = {}): Promise<{ http: number; status: string; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init, cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${idToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      });
    } catch { throw new CloudUpstreamError("unavailable"); }
    const json: unknown = await res.json().catch(() => null);
    // Only Google's status word (e.g. FAILED_PRECONDITION) is read from an error body; its message is dropped.
    const err = json && typeof json === "object" ? (json as { error?: { status?: unknown } }).error : undefined;
    const status = typeof err?.status === "string" ? err.status.slice(0, 40) : "";
    return { http: res.status, status, json };
  }

  private fail(r: { http: number; status: string }): never {
    if (r.http === 401 || r.status === "UNAUTHENTICATED") throw new CloudUpstreamError("unauthorized", r.http);
    if (r.http === 403 || r.status === "PERMISSION_DENIED") throw new CloudUpstreamError("forbidden", r.http);
    if (r.http === 404 || r.status === "NOT_FOUND") throw new CloudUpstreamError("no_database", r.http);
    throw new CloudUpstreamError("unavailable", r.http);
  }

  async list({ uid, idToken }: Caller) {
    const out: CloudSummary[] = [];
    // A field mask keeps plan bodies out of the list read. Slots are few; three pages of 50 is far more than enough.
    let pageToken = "";
    for (let page = 0; page < 3; page++) {
      const q = new URLSearchParams({ pageSize: "50" });
      for (const f of ["version", "updatedAt", "title", "eventType"]) q.append("mask.fieldPaths", f);
      if (pageToken) q.set("pageToken", pageToken);
      const r = await this.send(`${this.col(uid)}?${q}`, idToken);
      // No database yet (or nothing under this user): an empty list, not an error.
      if (r.http === 404 || r.status === "NOT_FOUND") return [];
      if (r.http !== 200) this.fail(r);
      const body = (r.json ?? {}) as { documents?: FsDoc[]; nextPageToken?: string };
      for (const d of Array.isArray(body.documents) ? body.documents : []) {
        const planKey = String(d.name ?? "").split("/").pop() ?? "";
        const f = d.fields ?? {};
        if (planKey) out.push({ planKey, version: int(f.version) ?? 0, updatedAt: time(f.updatedAt), title: str(f.title), eventType: str(f.eventType) });
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!pageToken) break;
    }
    return out.sort((a, b) => a.planKey.localeCompare(b.planKey));
  }

  /** The document and its updateTime (the CAS token), or null when absent (or the database doesn't exist yet). */
  private async getRaw(uid: string, idToken: string, planKey: string): Promise<{ doc: CloudDoc | null; updateTime: string } | null> {
    const r = await this.send(this.docUrl(uid, planKey), idToken);
    if (r.http === 404 || r.status === "NOT_FOUND") return null;
    if (r.http !== 200) this.fail(r);
    const d = (r.json ?? {}) as FsDoc;
    return { doc: fromFirestore(d), updateTime: typeof d.updateTime === "string" ? d.updateTime : "" };
  }

  async get({ uid, idToken }: Caller, planKey: string) {
    return (await this.getRaw(uid, idToken, planKey))?.doc ?? null;
  }

  async cas({ uid, idToken }: Caller, planKey: string, expectedVersion: number, data: Omit<CloudDoc, "version">): Promise<CloudCasResult> {
    const conflict = async (): Promise<CloudCasResult> => ({ ok: false, current: (await this.getRaw(uid, idToken, planKey))?.doc ?? null });
    const q = new URLSearchParams();
    if (expectedVersion === 0) q.set("currentDocument.exists", "false");
    else {
      const cur = await this.getRaw(uid, idToken, planKey);
      if (!cur || cur.doc?.version !== expectedVersion || !cur.updateTime) return { ok: false, current: cur?.doc ?? null };
      q.set("currentDocument.updateTime", cur.updateTime);
    }
    const version = expectedVersion + 1;
    // PATCH without an update mask replaces the whole document, so it holds exactly CLOUD_DOC_FIELDS.
    const r = await this.send(`${this.docUrl(uid, planKey)}?${q}`, idToken, {
      method: "PATCH", body: JSON.stringify({ fields: toFirestoreFields({ ...data, version }) }),
    });
    if (r.http === 200) return { ok: true, version, updatedAt: data.updatedAt };
    // Someone else wrote first: the precondition fails, or the rules refuse a version that is no longer current + 1.
    if (r.http === 409 || r.http === 412 || r.status === "ALREADY_EXISTS" || r.status === "FAILED_PRECONDITION" || r.status === "ABORTED") return conflict();
    if (r.http === 403 || r.status === "PERMISSION_DENIED") {
      const c = await conflict();
      if (!c.ok && (c.current?.version ?? 0) !== expectedVersion) return c;
    }
    this.fail(r);
  }
}
