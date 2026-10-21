// Live Gemini smoke test. Needs GEMINI_API_KEY in the environment or in .env.local.
//   npm run smoke:gemini
import { existsSync, readFileSync } from "node:fs";

if (!process.env.GEMINI_API_KEY && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.GEMINI_API_KEY ?? "";
if (!KEY) { console.error("✗ GEMINI_API_KEY not set (env or .env.local)"); process.exit(1); }
console.log(`key: ${KEY.length} chars, ${KEY.startsWith("AIza") ? "looks like a Gemini key" : "does NOT start with AIza (check .env.local)"}, model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`);

// Call Gemini once directly so a bad key / blocked network shows the real error instead of a silent fallback.
async function ping() {
  const { GoogleGenAI } = await import("@google/genai");
  try {
    const r = await new GoogleGenAI({ apiKey: KEY }).models.generateContent({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash", contents: "Reply with OK" });
    console.log(`✓ direct ping: "${(r.text ?? "").trim().slice(0, 40)}"`);
    return true;
  } catch (e) {
    console.log(`✗ direct ping failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`);
    return false;
  }
}

async function main() {
if (!(await ping())) { console.log("\nFix the error above first; the route checks would only fall back to Demo Mode."); process.exit(1); }
const { royalWedding } = await import("../src/presets");
const chat = (await import("../src/app/api/chat/route")).POST;
const scan = (await import("../src/app/api/scan-quote/route")).POST;
const TODAY = "2026-10-21";
const post = (body: unknown) => new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let failed = 0;
const check = (name: string, ok: boolean, detail: string, warning?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  if (!ok && warning) console.log(`    warning: ${warning}`);
  if (!ok) failed++;
};

// 1. Organizer: multi-step function calling → one Tier-1 batch
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, messages: [{ role: "user", text: "Cut ₹20k from decor and move the Haldi to Friday" }] }))).json();
  const batches = (r.actions ?? []).filter((a: { kind: string }) => a.kind === "batch");
  check("organizer chat", r.mode === "gemini" && batches.length > 0, `mode=${r.mode} batches=${batches.length} reply="${String(r.reply).slice(0, 90)}"`, r.warning);
  for (const b of batches) console.log("   ", b.tier, b.log?.join(" | "));
}
// 2. Organizer: over-cut → rollback + counter-offer
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, messages: [{ role: "user", text: "Cut ₹1.5L from decor" }] }))).json();
  const counter = (r.actions ?? []).some((a: { counterOffer?: boolean }) => a.counterOffer);
  check("over-cut counter-offer", r.mode === "gemini" && counter, `mode=${r.mode} counterOffer=${counter} reply="${String(r.reply).slice(0, 90)}"`, r.warning);
}
// 3. Guest: budget change must be refused by the reducer
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, role: "guest", actingGuestId: "g1", messages: [{ role: "user", text: "Cut ₹20k from decor" }] }))).json();
  const batches = (r.actions ?? []).filter((a: { kind: string }) => a.kind === "batch");
  check("guest boundary", r.mode === "gemini" && batches.length === 0, `mode=${r.mode} batches=${batches.length} reply="${String(r.reply).slice(0, 90)}"`, r.warning);
}
// 4. Vision: real image of the Deccan quote
{
  const img = readFileSync("samples/deccan-royal-caterers-quote.png").toString("base64");
  const r = await (await scan(post({ state: royalWedding, today: TODAY, imageBase64: img, mimeType: "image/png" }))).json();
  const q = r.scanned ?? {};
  check("vision quote scan", r.source === "gemini" && q.quotedPaise === 1_85_000_00,
    `source=${r.source} vendor=${q.vendorName} quoted=${q.quotedPaise} deposit=${q.depositRequiredPaise} due=${q.dueAt} flags=${(q.redFlags ?? []).length}`, r.warning ?? (r.source === "gemini" ? undefined : r.reply));
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll live Gemini checks passed");
process.exit(failed ? 1 : 0);
}
void main();
