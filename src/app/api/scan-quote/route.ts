// Vendor quote / contract scanner. Three inputs:
//   • { samplePresetId }                 → built-in sample document, deterministic parser (works with no key, no Wi-Fi)
//   • multipart file, or { dataUrl }     → Gemini Vision with structured JSON output (needs GEMINI_API_KEY)
//   • a plain-text upload                → deterministic parser
// Whatever reads the document, the result is one upsert_vendor_quote command, dry-run as a Tier-1 approval card.
import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentState } from "@/schema";
import type { Role } from "@/commands";
import { todayIST } from "@/insights";
import { geminiSchema } from "@/gemini-tools";
import { parseQuoteText, sampleQuote, scanToActions, SAMPLE_QUOTES, VisionExtraction, visionToScanned, type ScannedQuote, type ScanResponse } from "@/quote-scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;
const OK_MIME = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf|text\/plain)$/;

async function extractWithGemini(apiKey: string, mimeType: string, base64: string, st: AgentState, today: string): Promise<ScannedQuote> {
  const ai = new GoogleGenAI({ apiKey });
  const lines = st.budgetItems.map(b => `${b.category}: ${b.label}`).join("\n");
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType, data: base64 } },
      { text: `Extract this vendor quote / invoice / contract for "${st.event.title}". Today is ${today}.
Pick the category and, when it clearly matches, reuse the wording of one of these existing budget lines as itemLabel:
${lines}
Sub-event slugs: ${st.subEvents.map(s => s.slug).join(", ")}.
Copy amounts exactly as printed (whole rupees). Do not compute totals. List risky clauses (non-refundable deposits, corkage, overtime, cancellation, hidden taxes, uncapped liability) as redFlags.` },
    ] }],
    config: { responseMimeType: "application/json", responseJsonSchema: geminiSchema(z.toJSONSchema(VisionExtraction, { target: "draft-2020-12", io: "input" })), temperature: 0 },
  });
  const parsed = VisionExtraction.safeParse(JSON.parse(res.text ?? "{}"));
  if (!parsed.success) throw new Error(`Unreadable extraction: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return visionToScanned(parsed.data, today);
}

export async function POST(request: Request) {
  let stateRaw: unknown, today = todayIST(), role: Role = "organizer";
  let samplePresetId: string | null = null;
  let file: { mimeType: string; base64: string; name: string; text?: string } | null = null;

  const ctype = request.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await request.formData();
      stateRaw = JSON.parse(String(form.get("state") ?? "null"));
      today = String(form.get("today") ?? today);
      role = form.get("role") === "guest" ? "guest" : "organizer";
      const key = form.get("samplePresetId") ?? form.get("presetQuoteKey");
      samplePresetId = key ? String(key) : null;
      const f = form.get("file");
      if (f && typeof f === "object" && "arrayBuffer" in f) {
        if (f.size > MAX_BYTES) return NextResponse.json({ error: "File too large (10 MB max)" }, { status: 413 });
        const buf = Buffer.from(await f.arrayBuffer());
        file = { mimeType: f.type || "application/octet-stream", base64: buf.toString("base64"), name: f.name, ...(f.type === "text/plain" ? { text: buf.toString("utf8") } : {}) };
      }
    } else {
      const body = (await request.json()) as { state?: unknown; today?: string; role?: string; samplePresetId?: string; presetQuoteKey?: string;
        dataUrl?: string; imageBase64?: string; mimeType?: string; fileName?: string };
      stateRaw = body.state; today = body.today ?? today; role = body.role === "guest" ? "guest" : "organizer";
      samplePresetId = body.samplePresetId ?? body.presetQuoteKey ?? null;
      const raw = body.dataUrl ?? (body.imageBase64 ? (body.imageBase64.startsWith("data:") ? body.imageBase64 : `data:${body.mimeType ?? "image/png"};base64,${body.imageBase64}`) : undefined);
      const m = raw?.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[2]!, "base64");
        if (buf.length > MAX_BYTES) return NextResponse.json({ error: "File too large (10 MB max)" }, { status: 413 });
        file = { mimeType: m[1]!, base64: m[2]!, name: body.fileName ?? "upload", ...(m[1] === "text/plain" ? { text: buf.toString("utf8") } : {}) };
      }
    }
  } catch {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) today = todayIST();
  const parsed = AgentState.safeParse(stateRaw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid plan state" }, { status: 400 });
  const st = parsed.data;
  if (role === "guest") return NextResponse.json({ source: "unavailable", reply: "Quote scanning is an organiser tool.", actions: [] } satisfies ScanResponse);

  const finish = (source: ScanResponse["source"], q: ScannedQuote, warning?: string) => {
    const r = scanToActions(q, st, today, role, source);
    return NextResponse.json({ source, mode: source === "gemini" ? "gemini" : "offline", scanned: q, reply: r.reply, actions: r.actions, ...(warning ? { warning } : {}) } satisfies ScanResponse);
  };

  if (samplePresetId) {
    const q = sampleQuote(samplePresetId, today);
    if (!q) return NextResponse.json({ error: `Unknown sample. Use one of: ${SAMPLE_QUOTES.map(s => `${s.id} (${s.archetype})`).join(", ")}` }, { status: 400 });
    return finish("sample", q);
  }
  if (!file) return NextResponse.json({ error: "Send a file, a dataUrl, or a samplePresetId" }, { status: 400 });
  if (!OK_MIME.test(file.mimeType)) return NextResponse.json({ error: `Unsupported file type ${file.mimeType}. Use an image, PDF or .txt.` }, { status: 415 });
  if (file.text !== undefined) return finish("text", parseQuoteText(file.text, today));

  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ source: "unavailable", actions: [],
    reply: "Reading images and PDFs needs a GEMINI_API_KEY. Meanwhile, try one of the sample quotes: same pipeline, no key needed." } satisfies ScanResponse);
  try {
    return finish("gemini", await extractWithGemini(key, file.mimeType, file.base64, st, today));
  } catch (e) {
    return NextResponse.json({ source: "unavailable", actions: [],
      reply: `I couldn't read ${file.name}: ${e instanceof Error ? e.message.slice(0, 160) : "error"}. Try a clearer photo, or a sample quote.` } satisfies ScanResponse);
  }
}
