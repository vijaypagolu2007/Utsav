// The only file that talks to the Gemini SDK. Everything above it receives a GenerateFn, so tests inject a
// mock and never need a real key. Provider failures are classified once here, so the routes can decide
// what is safe to fall back from and what is a real error.
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part, type ThinkingLevel } from "@google/genai";
import { geminiThinkingLevel, isTransientGeminiError, withGeminiRetry } from "@/gemini-model";

/**
 * Output-token cap per route, sent as generationConfig.maxOutputTokens on every call. It bounds a runaway answer's
 * cost and latency; it is not meant to shorten real answers. Thinking tokens count against the cap on Gemini 3, so
 * each value leaves room for LOW/MEDIUM thinking on top of the largest schema-sized answer:
 * - chat 4096: /api/chat turns (tool calls, short replies), "Get more ideas" (suggest_ideas, at most 8 cards of
 *   120 + 400 characters, about 2k tokens at the schema maximum) and "Questions to ask" (at most 10 × 220 characters).
 * - plan 8192: initialize_event_plan. The largest deterministic blueprint in the tests (community, 11 days,
 *   12 sub-events) is about 4.4k characters (~1.5k tokens); the schema maximum (12 sub-events, 40 budget lines,
 *   60 tasks, 80 run-of-show blocks) is roughly 20k characters (~6-7k tokens).
 * - scan 4096: the vision quote extraction JSON (a vendor, amounts and a handful of short lists, ~1k tokens).
 * A reply that stops at the cap (finishReason MAX_TOKENS) is truncated and is treated as malformed_response.
 */
export const GEMINI_MAX_OUTPUT_TOKENS = { chat: 4096, plan: 8192, scan: 4096 } as const;

export type GenerateParams = {
  contents: Content[];
  /** Always set from GEMINI_MAX_OUTPUT_TOKENS, so no call goes out uncapped. */
  maxOutputTokens: number;
  systemInstruction?: string;
  functionDeclarations?: FunctionDeclaration[];
  responseMimeType?: "application/json";
  responseJsonSchema?: unknown;
  temperature?: number;
};
/** The subset of the SDK response we read. Everything in it is treated as untrusted. */
export type GenerateResult = {
  text?: string | null;
  functionCalls?: { id?: string; name?: string; args?: unknown }[] | null;
  candidates?: { content?: Content | null; finishReason?: string | null }[] | null;
};
export type GenerateFn = (p: GenerateParams, opts: { signal: AbortSignal }) => Promise<GenerateResult>;

export type ProviderFailure = "auth" | "model_not_found" | "rate_limited" | "unavailable" | "timeout" | "malformed_response" | "bad_request" | "unknown";

export class ProviderError extends Error {
  constructor(public readonly kind: ProviderFailure, message: string, public readonly status?: number) { super(message); this.name = "ProviderError"; }
}

export function classifyProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number } | null)?.status ?? Number(msg.match(/"code"\s*:\s*(\d{3})/)?.[1] ?? NaN);
  if ((e as { name?: string } | null)?.name === "AbortError" || /timed out|aborted/i.test(msg)) return new ProviderError("timeout", "Gemini request timed out");
  if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg) || status === 401 || status === 403) return new ProviderError("auth", "Gemini rejected the API key or its permissions", status);
  if (status === 404) return new ProviderError("model_not_found", "The configured Gemini model is not available to this key", 404);
  if (status === 429) return new ProviderError("rate_limited", "Gemini rate limit reached", 429);
  if (isTransientGeminiError(e)) return new ProviderError("unavailable", "Gemini is temporarily unavailable", status);
  if (status === 400) return new ProviderError("bad_request", "Gemini rejected the request", 400);
  return new ProviderError("unknown", "Gemini call failed", Number.isFinite(status) ? status : undefined);
}

/** A reply cut off at maxOutputTokens is truncated (half a function call or JSON object): never use it. */
export function assertNotTruncated<T extends GenerateResult | null | undefined>(res: T): T {
  if (res?.candidates?.some(c => c?.finishReason === "MAX_TOKENS")) throw new ProviderError("malformed_response", "Gemini stopped at the output-token cap (finishReason MAX_TOKENS)");
  return res;
}

export function isThinkingConfigRejected(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number } | null)?.status ?? Number(msg.match(/"code"\s*:\s*(\d{3})/)?.[1] ?? NaN);
  return status === 400 && /thinking/i.test(msg);
}

export function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { ctl.abort(); reject(new ProviderError("timeout", `Gemini request timed out after ${ms / 1000}s`)); }, ms);
    run(ctl.signal).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Real client. The key is read from server env by the caller and never leaves this module. */
export function geminiGenerate(apiKey: string, opts: { retryDelaysMs?: number[] } = {}): GenerateFn {
  const ai = new GoogleGenAI({ apiKey });
  const thinkingLevel = geminiThinkingLevel();
  const call = (p: Parameters<GenerateFn>[0], signal: AbortSignal, model: string, withThinking: boolean) => ai.models.generateContent({
    model,
    contents: p.contents,
    config: {
      abortSignal: signal,
      ...(p.systemInstruction ? { systemInstruction: p.systemInstruction } : {}),
      ...(p.functionDeclarations ? { tools: [{ functionDeclarations: p.functionDeclarations }] } : {}),
      ...(p.responseMimeType ? { responseMimeType: p.responseMimeType } : {}),
      ...(p.responseJsonSchema ? { responseJsonSchema: p.responseJsonSchema } : {}),
      ...(withThinking && thinkingLevel ? { thinkingConfig: { thinkingLevel: thinkingLevel as ThinkingLevel } } : {}),
      temperature: p.temperature ?? 0.2,
      maxOutputTokens: p.maxOutputTokens,
    },
  });
  return (p, { signal }) => withGeminiRetry(async model => {
    let res;
    try {
      res = await call(p, signal, model, true);
    } catch (e) {
      // A model that doesn't accept thinkingLevel answers 400; ask once more without it rather than failing the turn.
      if (thinkingLevel && isThinkingConfigRejected(e)) res = await call(p, signal, model, false);
      else throw e;
    }
    // Not transient, so withGeminiRetry rethrows it at once; every route already falls back from malformed_response.
    return assertNotTruncated(res as GenerateResult);
  }, { delaysMs: opts.retryDelaysMs ?? [800, 2000] }) as Promise<GenerateResult>;
}

export type { Content, Part, FunctionDeclaration };
