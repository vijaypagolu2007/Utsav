// v8 Part 2: per-IP rate limits for the AI routes (/api/chat, /api/scan-quote, /api/plan), on the same fixed-window
// limiter and RATE table as the shared-event routes (src/server/events.ts).
// Counters live in the shared store when one is configured (Upstash Redis in production; the file store's in-memory
// counters in local dev and E2E). Without one (a production build with no Redis) they fall back to a per-instance
// in-memory counter, so the AI routes are never unlimited and never refuse to answer for lack of storage.
import { limited, type RATE } from "./events";
import { clientIp, type HandlerResult } from "./http";
import { getStore, MemoryStore, type EventStore } from "./store";

export type AiScope = Extract<keyof typeof RATE, "aiChat" | "aiScan" | "aiPlan">;

let fallback: EventStore | null = null;

/** null when the request may go ahead; otherwise the 429 (with Retry-After) to send back. */
export async function aiLimited(request: Request, scope: AiScope): Promise<HandlerResult | null> {
  const store = getStore().store ?? (fallback ??= new MemoryStore());
  return limited(store, scope, clientIp(request));
}
