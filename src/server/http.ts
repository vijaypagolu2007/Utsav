// Small, framework-free HTTP helpers shared by every API route. Handlers return { status, body, headers }
// so they can be unit-tested without Next.js; the route files only translate that into a Response.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type HandlerResult = { status: number; body: unknown; headers?: Record<string, string> };

/** Private, event-specific data must never be cached by a CDN or a shared proxy. */
export const NO_STORE = { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" } as const;

export const ok = (body: unknown, status = 200): HandlerResult => ({ status, body });
export const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): HandlerResult =>
  ({ status, body: { error, message, ...extra } });

export function toResponse(r: HandlerResult): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...r.headers } });
}

/**
 * Read a request body as text without trusting Content-Length: the stream is consumed chunk by chunk and
 * abandoned as soon as it passes `maxBytes`, so an oversized upload is never fully buffered.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; result: HandlerResult }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, result: fail(413, "payload_too_large", `Request body exceeds ${Math.round(maxBytes / 1024)} KB`) };
  if (!request.body) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, result: fail(413, "payload_too_large", `Request body exceeds ${Math.round(maxBytes / 1024)} KB`) };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { ok: true, bytes: out };
}

export async function readJsonLimited(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; result: HandlerResult }> {
  const b = await readBodyLimited(request, maxBytes);
  if (!b.ok) return b;
  try { return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b.bytes)) }; }
  catch { return { ok: false, result: fail(400, "invalid_json", "Request body must be valid UTF-8 JSON") }; }
}

/** Zod issues → a short, safe list (paths and messages only, never the offending values). */
export const issuesOf = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.slice(0, 5).map(i => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

// ---------- tokens ----------
/** 128 bits for public ids, 256 bits for bearer secrets; base64url, no padding. */
export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const bearerToken = (request: Request): string | null => {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  return m ? m[1]! : null;
};

/** Best-effort client IP for rate limiting (Vercel sets x-forwarded-for / x-real-ip). Never used for auth. */
export const clientIp = (request: Request) =>
  (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local").slice(0, 64);

// ---------- provider key ----------
/** The Gemini key, read on the server only. UTSAV_DISABLE_GEMINI=1 forces Demo Mode even when .env.local holds a key
 *  (Next deletes empty env vars before loading .env files, so GEMINI_API_KEY="" alone cannot force it off). */
export function geminiApiKey(): string | null {
  if (process.env.UTSAV_DISABLE_GEMINI === "1") return null;
  return process.env.GEMINI_API_KEY?.trim() || null;
}

// ---------- logging ----------
const SECRET_PATTERNS = [/AIza[0-9A-Za-z_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]+/gi, /([?&]key=)[^&\s]+/gi, /"(token|apiKey|api_key|authorization)"\s*:\s*"[^"]*"/gi];
export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, m => (m.startsWith("?") || m.startsWith("&") ? m.replace(/=.*/, "=[redacted]") : "[redacted]"));
  if (process.env.GEMINI_API_KEY) out = out.split(process.env.GEMINI_API_KEY).join("[redacted]");
  return out.slice(0, 600);
}
/** Server-side diagnostics only: event names and status codes, no plans, no guest names, no secrets. */
export function logServer(scope: string, event: string, detail: Record<string, unknown> = {}) {
  if (process.env.UTSAV_SILENT_LOGS === "1") return;
  const safe = Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]));
  console.warn(`[utsav:${scope}] ${event}`, JSON.stringify(safe));
}
