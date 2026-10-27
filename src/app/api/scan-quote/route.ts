// Vendor quote / contract scanner route. Logic and validation live in src/server/scan-handler.ts (unit-tested
// with a mocked Gemini). The body is read with a hard byte cap before any parsing.
import { handleScan, scanInputFromForm, scanInputFromJson, SCAN_MAX_BODY_BYTES } from "@/server/scan-handler";
import { geminiGenerate } from "@/server/gemini-client";
import { aiLimited } from "@/server/ai-limit";
import { fail, logServer, readBodyLimited, toResponse, geminiApiKey } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const rl = await aiLimited(request, "aiScan");
  if (rl) return toResponse(rl);
  const ctype = request.headers.get("content-type") ?? "";
  const body = await readBodyLimited(request, SCAN_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  let input;
  if (ctype.startsWith("multipart/form-data")) {
    let form: FormData;
    try { form = await new Response(Buffer.from(body.bytes), { headers: { "content-type": ctype } }).formData(); }
    catch { return toResponse(fail(400, "invalid_multipart", "Malformed multipart body")); }
    input = await scanInputFromForm(form);
  } else if (ctype.startsWith("application/json") || ctype === "") {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)); }
    catch { return toResponse(fail(400, "invalid_json", "Request body must be valid UTF-8 JSON")); }
    input = scanInputFromJson(raw);
  } else {
    return toResponse(fail(415, "unsupported_media_type", "Use application/json or multipart/form-data"));
  }
  if (!input.ok) return toResponse(input.result);
  const apiKey = geminiApiKey();
  try {
    return toResponse(await handleScan(input.input, { apiKey, generate: apiKey ? geminiGenerate(apiKey, { retryDelaysMs: [1000] }) : null }));
  } catch (e) {
    logServer("scan", "internal_error", { message: e instanceof Error ? e.message : String(e) });
    return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
  }
}
