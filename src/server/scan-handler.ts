// /api/scan-quote logic, framework-free. Inputs (all documented in the README):
//   JSON  { presetQuoteKey | samplePresetId }            → built-in sample, deterministic parser, no key needed
//   JSON  { imageBase64 + mimeType } or { dataUrl }       → Gemini Vision (needs GEMINI_API_KEY)
//   multipart { file, state, today, samplePresetId? }      → same; .txt files use the deterministic parser
// Every path ends in one upsert_vendor_quote dry-run → a Tier-1 approval card. Nothing is committed here.
import { geminiTimeoutMs } from "@/gemini-model";
import { z } from "zod";
import { AgentState } from "@/schema";
import { todayIST } from "@/insights";
import { geminiSchema } from "@/gemini-tools";
import { parseQuoteText, QuoteValidationError, sampleQuote, scanToActions, SAMPLE_QUOTES, VisionExtraction, visionToScanned,
  type ScannedQuote, type ScanResponse } from "@/quote-scanner";
import { fail, issuesOf, logServer, ok, type HandlerResult } from "./http";
import { classifyProviderError, GEMINI_MAX_OUTPUT_TOKENS, ProviderError, withDeadline, type GenerateFn } from "./gemini-client";

/** Vercel functions accept ~4.5 MB request bodies; base64 adds a third, so files are capped at 3 MB. */
export const SCAN_MAX_FILE_BYTES = 3 * 1024 * 1024;
export const SCAN_MAX_TEXT_BYTES = 200 * 1024;
export const SCAN_MAX_BODY_BYTES = Math.ceil(SCAN_MAX_FILE_BYTES * 4 / 3) + 512 * 1024;
export const SCAN_TIMEOUT_MS = 40_000;

export type ScanKind = "png" | "jpeg" | "webp" | "heic" | "pdf" | "text";
const MIME_OF: Record<ScanKind, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", pdf: "application/pdf", text: "text/plain" };
const DECLARED: Record<string, ScanKind> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/webp": "webp", "image/heic": "heic", "image/heif": "heic",
  "application/pdf": "pdf", "text/plain": "text",
};

/** Identify the file from its first bytes. MIME headers and extensions are only cross-checked, never trusted. */
export function sniff(buf: Uint8Array): ScanKind | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => buf[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map(c => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(4, "ftyp") && ["heic", "heix", "hevc", "mif1", "msf1", "heif"].some(b => ascii(8, b))) return "heic";
  if (ascii(0, "%PDF-")) return "pdf";
  return null;
}

function asText(buf: Uint8Array): string | null {
  if (buf.length > SCAN_MAX_TEXT_BYTES || buf.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; }
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export function decodeBase64Strict(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, "");
  if (!clean || clean.length % 4 !== 0 || !B64.test(clean)) return null;
  if (clean.length * 3 / 4 > SCAN_MAX_FILE_BYTES + 3) return null;
  return new Uint8Array(Buffer.from(clean, "base64"));
}

const JsonScan = z.object({
  state: z.unknown(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  role: z.enum(["organizer", "guest"]).optional(),
  samplePresetId: z.string().max(64).optional(),
  presetQuoteKey: z.string().max(64).optional(),
  imageBase64: z.string().optional(),
  mimeType: z.string().max(100).optional(),
  dataUrl: z.string().optional(),
  fileName: z.string().max(200).optional(),
}).strict();

export type ScanInput = {
  state: unknown; today?: string; role?: "organizer" | "guest"; sampleKey?: string;
  file?: { bytes: Uint8Array; declaredMime: string; name: string } | null;
};

/** Normalise a parsed JSON body into a ScanInput (or an HTTP error). */
export function scanInputFromJson(raw: unknown): { ok: true; input: ScanInput } | { ok: false; result: HandlerResult } {
  const p = JsonScan.safeParse(raw);
  if (!p.success) return { ok: false, result: fail(400, "invalid_request", "Malformed scan request", { issues: issuesOf(p.error.issues) }) };
  const b = p.data;
  let file: ScanInput["file"] = null;
  if (b.dataUrl !== undefined || b.imageBase64 !== undefined) {
    let mime = b.mimeType ?? "", data = b.imageBase64 ?? "";
    const src = b.dataUrl ?? (data.startsWith("data:") ? data : null);
    if (src !== null) {
      const m = src.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s);
      if (!m) return { ok: false, result: fail(400, "invalid_base64", "dataUrl must look like data:<mime>;base64,<data>") };
      mime = m[1]!; data = m[2]!;
    }
    const bytes = decodeBase64Strict(data);
    if (!bytes) return { ok: false, result: data.replace(/\s+/g, "").length * 3 / 4 > SCAN_MAX_FILE_BYTES
      ? fail(413, "file_too_large", `Files are limited to ${SCAN_MAX_FILE_BYTES / 1024 / 1024} MB`)
      : fail(400, "invalid_base64", "imageBase64 is not valid base64") };
    file = { bytes, declaredMime: mime, name: b.fileName ?? "upload" };
  }
  return { ok: true, input: { state: b.state, today: b.today, role: b.role, sampleKey: b.presetQuoteKey ?? b.samplePresetId, file } };
}

/** Normalise multipart form data. */
export async function scanInputFromForm(form: FormData): Promise<{ ok: true; input: ScanInput } | { ok: false; result: HandlerResult }> {
  let state: unknown;
  try { state = JSON.parse(String(form.get("state") ?? "null")); } catch { return { ok: false, result: fail(400, "invalid_state", "state must be JSON") }; }
  const today = form.get("today"), role = form.get("role"), key = form.get("samplePresetId") ?? form.get("presetQuoteKey");
  if (role !== null && role !== "organizer" && role !== "guest") return { ok: false, result: fail(400, "invalid_role", "role must be organizer or guest") };
  const f = form.get("file");
  let file: ScanInput["file"] = null;
  if (f !== null) {
    if (typeof f === "string" || !("arrayBuffer" in f)) return { ok: false, result: fail(400, "invalid_file", "file must be an uploaded file") };
    if (f.size > SCAN_MAX_FILE_BYTES) return { ok: false, result: fail(413, "file_too_large", `Files are limited to ${SCAN_MAX_FILE_BYTES / 1024 / 1024} MB`) };
    file = { bytes: new Uint8Array(await f.arrayBuffer()), declaredMime: f.type || "", name: (f.name || "upload").slice(0, 200) };
  }
  return { ok: true, input: { state, today: typeof today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined,
    role: (role ?? undefined) as ScanInput["role"], sampleKey: typeof key === "string" ? key.slice(0, 64) : undefined, file } };
}

export type ScanDeps = { apiKey?: string | null; generate?: GenerateFn | null; timeoutMs?: number };
export type ScanResponseBody = ScanResponse & { detectedType?: ScanKind };

export async function handleScan(input: ScanInput, deps: ScanDeps): Promise<HandlerResult> {
  const st = AgentState.safeParse(input.state);
  if (!st.success) return fail(400, "invalid_state", "The plan state failed validation", { issues: issuesOf(st.error.issues) });
  const plan = st.data;
  const today = input.today ?? todayIST();
  if (input.role === "guest") return fail(403, "forbidden", "Quote scanning is an organizer tool");

  const finish = (source: ScanResponse["source"], q: ScannedQuote, detectedType?: ScanKind) => {
    const r = scanToActions(q, plan, today, "organizer", source);
    return ok({ source, mode: source === "gemini" ? "gemini" : "offline", scanned: q, reply: r.reply, actions: r.actions,
      ...(detectedType ? { detectedType } : {}) } satisfies ScanResponseBody);
  };

  if (input.sampleKey) {
    const q = sampleQuote(input.sampleKey, today);
    if (!q) return fail(400, "unknown_sample", `Unknown sample. Use one of: ${SAMPLE_QUOTES.map(s => `${s.id} (${s.archetype})`).join(", ")}`);
    return finish("sample", q);
  }
  const file = input.file;
  if (!file) return fail(400, "missing_file", "Send a file, imageBase64 + mimeType, a dataUrl, or a presetQuoteKey");
  if (!file.bytes.length) return fail(400, "empty_file", "The uploaded file is empty");
  if (file.bytes.length > SCAN_MAX_FILE_BYTES) return fail(413, "file_too_large", `Files are limited to ${SCAN_MAX_FILE_BYTES / 1024 / 1024} MB`);

  const declared = DECLARED[file.declaredMime.toLowerCase()];
  if (file.declaredMime && !declared) return fail(415, "unsupported_type", `Unsupported file type ${file.declaredMime.slice(0, 60)}. Use PNG, JPEG, WebP, HEIC, PDF or .txt.`);
  const detected = sniff(file.bytes);
  if (detected) {
    if (declared && declared !== detected) return fail(415, "type_mismatch", `The file content is ${MIME_OF[detected]}, not ${file.declaredMime}`);
  } else {
    // No binary signature: only plain UTF-8 text is acceptable.
    if (declared && declared !== "text") return fail(415, "type_mismatch", `The file content doesn't match ${file.declaredMime}`);
    const text = asText(file.bytes);
    if (text === null) return fail(415, "unsupported_type", "Unrecognised file. Use PNG, JPEG, WebP, HEIC, PDF or a UTF-8 .txt under 200 KB.");
    let q: ScannedQuote;
    try { q = parseQuoteText(text, today); } catch { return fail(422, "unreadable_quote", "Couldn't find a vendor and a total in that text"); }
    if (q.quotedPaise <= 0) return fail(422, "unreadable_quote", "Couldn't find a grand total in that text");
    return finish("text", q, "text");
  }

  if (!deps.apiKey || !deps.generate) {
    return ok({ source: "unavailable", actions: [], detectedType: detected,
      reply: "Reading images and PDFs needs GEMINI_API_KEY on the server. Meanwhile, try a sample quote: same pipeline, no key needed." } satisfies ScanResponseBody);
  }
  const lines = plan.budgetItems.map(b => `${b.category}: ${b.label}`).join("\n");
  const prompt = `Extract this vendor quote / invoice / contract for "${plan.event.title}". Today is ${today}.
Pick the category and, when it clearly matches, reuse the wording of one of these existing budget lines as itemLabel:
${lines}
Sub-event slugs: ${plan.subEvents.map(s => s.slug).join(", ")}.
Copy amounts exactly as printed (rupees). Do not compute totals or dates. If a value is missing or unreadable, omit it and name it in "uncertain".
List risky clauses (non-refundable deposits, corkage, overtime, cancellation, hidden taxes, uncapped liability) as redFlags.`;
  let rawText: string;
  try {
    const res = await withDeadline(signal => deps.generate!({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: MIME_OF[detected], data: Buffer.from(file.bytes).toString("base64") } }, { text: prompt }] }],
      responseMimeType: "application/json",
      responseJsonSchema: geminiSchema(z.toJSONSchema(VisionExtraction, { target: "draft-2020-12", io: "input" })),
      temperature: 0,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS.scan,
    }, { signal }), deps.timeoutMs ?? geminiTimeoutMs(SCAN_TIMEOUT_MS, 55_000));
    if (!res || (res.text !== undefined && res.text !== null && typeof res.text !== "string")) throw new ProviderError("malformed_response", "No text in response");
    rawText = res.text ?? "";
  } catch (e) {
    const pe = classifyProviderError(e);
    logServer("scan", "provider_failure", { kind: pe.kind, status: pe.status ?? null, type: detected, bytes: file.bytes.length });
    const status = pe.kind === "rate_limited" ? 429 : pe.kind === "timeout" ? 504 : 502;
    return fail(status, `provider_${pe.kind}`, pe.kind === "rate_limited" ? "The AI reader is rate-limited. Try again in a minute, or use a sample quote."
      : pe.kind === "timeout" ? "Reading the document took too long. Try a smaller or clearer file." : "The AI reader couldn't process this document right now.");
  }
  let json: unknown;
  try { json = JSON.parse(rawText); } catch {
    logServer("scan", "malformed_output", { type: detected, length: rawText.length });
    return fail(502, "provider_malformed_response", "The AI reader returned an unreadable result. Try a clearer photo.");
  }
  const parsed = VisionExtraction.safeParse(json);
  if (!parsed.success) {
    logServer("scan", "schema_mismatch", { type: detected, issues: issuesOf(parsed.error.issues).join("; ") });
    return fail(502, "provider_malformed_response", "The AI reader's result didn't match the expected fields. Try a clearer photo.");
  }
  try {
    return finish("gemini", visionToScanned(parsed.data, today), detected);
  } catch (e) {
    if (e instanceof QuoteValidationError) return fail(422, "implausible_quote", `The document was read, but ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}. Nothing was staged.`);
    throw e;
  }
}
