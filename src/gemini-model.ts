// One place for the model id. Google retires model ids for new keys (gemini-2.5-flash now returns 404),
// so override with GEMINI_MODEL instead of editing code. Flash-Lite is the default because the free tier allows it
// 15 RPM / 500 RPD (gemini-3.8-flash: 5 RPM / 20 RPD), and it passed the live smoke run incl. tools and vision.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const geminiModel = (): string => process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

/**
 * Gemini 3 models think at a high level by default, which can take longer than a chat turn allows (the
 * Windows smoke run timed out at 30 s while a plain ping worked). Default to LOW; GEMINI_THINKING_LEVEL can be
 * MINIMAL, LOW, MEDIUM or HIGH, or "default" to send nothing and let the model decide.
 */
export function geminiThinkingLevel(): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  const v = (process.env.GEMINI_THINKING_LEVEL ?? "").trim().toUpperCase();
  if (v === "DEFAULT" || v === "OFF" || v === "NONE") return undefined;
  return v === "MINIMAL" || v === "LOW" || v === "MEDIUM" || v === "HIGH" ? v : "LOW";
}

/** Per-call Gemini timeout: GEMINI_TIMEOUT_MS when set (clamped to 5 s – maxMs), otherwise the route's default. */
export function geminiTimeoutMs(defaultMs: number, maxMs: number): number {
  const n = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 5_000), maxMs) : defaultMs;
}

/** Primary model, then any comma-separated GEMINI_FALLBACK_MODELS. */
export const geminiModels = (): string[] =>
  [geminiModel(), ...(process.env.GEMINI_FALLBACK_MODELS ?? "").split(",").map(s => s.trim()).filter(Boolean)]
    .filter((m, i, a) => a.indexOf(m) === i);

/** 429 / 500 / 503 ("high demand") / 504 (DEADLINE_EXCEEDED) are worth retrying; 400 / 403 / 404 are not. */
export function isTransientGeminiError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number } | null)?.status;
  return status === 429 || status === 500 || status === 503 || status === 504 ||
    /"code":\s*(429|500|503|504)|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|high demand|overloaded/i.test(msg);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Runs `call(model)` with backoff on transient errors, moving to the next fallback model when one stays busy.
 * Delays default to 1 s and 3 s (3 attempts per model). Non-transient errors are thrown immediately.
 */
export async function withGeminiRetry<T>(call: (model: string) => Promise<T>, opts: { delaysMs?: number[]; onRetry?: (info: { model: string; attempt: number; error: unknown }) => void } = {}): Promise<T> {
  const delays = opts.delaysMs ?? [1000, 3000];
  let last: unknown;
  for (const model of geminiModels()) {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try { return await call(model); } catch (e) {
        last = e;
        if (!isTransientGeminiError(e)) throw e;
        if (attempt < delays.length) { opts.onRetry?.({ model, attempt: attempt + 1, error: e }); await sleep(delays[attempt]!); }
      }
    }
  }
  throw last;
}
