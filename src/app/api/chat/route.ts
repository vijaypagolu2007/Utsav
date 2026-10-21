// Gemini co-pilot route. All logic lives in src/server/chat-handler.ts (unit-tested with a mocked Gemini).
// The key is read here, on the server only; it is never sent to the browser or logged.
import { handleChat, CHAT_MAX_BODY_BYTES } from "@/server/chat-handler";
import { geminiGenerate } from "@/server/gemini-client";
import { fail, logServer, readJsonLimited, toResponse, geminiApiKey } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await readJsonLimited(request, CHAT_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  const apiKey = geminiApiKey();
  try {
    return toResponse(await handleChat(body.value, { apiKey, generate: apiKey ? geminiGenerate(apiKey) : null }));
  } catch (e) {
    logServer("chat", "internal_error", { message: e instanceof Error ? e.message : String(e) });
    return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
  }
}
