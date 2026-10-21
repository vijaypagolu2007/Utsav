// Live Gemini smoke test. Needs GEMINI_API_KEY in the environment or in .env.local.
//   npm run smoke:gemini
// Exit codes: 0 = all live checks passed, 1 = a check FAILED, 2 = BLOCKED (bad/missing key, quota, provider down).
// A BLOCKED run is not a pass: mocks in `npm test` never stand in for this.
import { existsSync, readFileSync } from "node:fs";
import { geminiModels, withGeminiRetry, geminiThinkingLevel, geminiTimeoutMs } from "../src/gemini-model";

if (!process.env.GEMINI_API_KEY && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.GEMINI_API_KEY ?? "";
if (!KEY) { console.error("BLOCKED: GEMINI_API_KEY not set (env or .env.local)"); process.exit(2); }
delete process.env.UTSAV_DISABLE_GEMINI;
// A stalled network (DNS, proxy, firewall) must end as BLOCKED, never hang the release gate.
const WATCHDOG_MS = 8 * 60_000; // ping retries + paced checks on the free tier can take ~6 min
setTimeout(() => { console.log(`\nBLOCKED: no result after ${WATCHDOG_MS / 60_000} min (network or provider stalled). Nothing here counts as passing.`); process.exit(2); }, WATCHDOG_MS).unref();
console.log(`key: ${KEY.length} chars, ${/\s|["']/.test(KEY) ? "contains spaces or quotes (check .env.local)" : "format ok"}, models: ${geminiModels().join(" → ")}`);

// Call Gemini once directly so a bad key / blocked network shows the real error instead of a silent fallback.
async function ping() {
  const { GoogleGenAI } = await import("@google/genai");
  type ThinkingLevel = import("@google/genai").ThinkingLevel;
  try {
    const ai = new GoogleGenAI({ apiKey: KEY, httpOptions: { timeout: 60_000 } });
    const level = geminiThinkingLevel();
    console.log(`  pinging Gemini (60 s timeout per attempt, thinking ${level ?? "model default"}, route timeout ${geminiTimeoutMs(30_000, 45_000) / 1000} s)…`);
    let used = "";
    const t0 = Date.now();
    const r = await withGeminiRetry(model => { used = model; return ai.models.generateContent({ model, contents: "Reply with OK", ...(level ? { config: { thinkingConfig: { thinkingLevel: level as ThinkingLevel } } } : {}) }); },
      // Free tier allows ~5 requests a minute, so ping at most twice and space the attempts out.
      { delaysMs: [15000], onRetry: ({ model, attempt }) => console.log(`  … ${model} busy (attempt ${attempt}), retrying`) });
    console.log(`✓ direct ping (${used}): "${(r.text ?? "").trim().slice(0, 40)}" in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return true;
  } catch (e) {
    console.log(`✗ direct ping failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`);
    return false;
  }
}

async function main() {
if (!(await ping())) { console.log("\nBLOCKED: Gemini is unreachable with this key (see the error above). Route checks skipped; nothing here counts as passing. A 429 or 504 on the free tier usually means the per-minute or per-day limit: check AI Studio's rate-limit page."); process.exitCode = 2; return; }
const { royalWedding } = await import("../src/presets");
const chat = (await import("../src/app/api/chat/route")).POST;
const scan = (await import("../src/app/api/scan-quote/route")).POST;
const TODAY = "2026-10-21";
const post = (body: unknown) => new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let failed = 0, blocked = 0;
// Provider-side trouble (quota, overload, timeout) means the check couldn't run, not that our code is wrong:
// it is counted as BLOCKED, which is never reported as a pass.
const PROVIDER_SIDE = new Set(["rate_limited", "unavailable", "timeout", "provider_rate_limited", "provider_unavailable", "provider_timeout"]);
const check = (name: string, ok: boolean, detail: string, warning?: string, providerReason?: string) => {
  const isBlocked = !ok && !!providerReason && PROVIDER_SIDE.has(providerReason);
  console.log(`${ok ? "✓" : isBlocked ? "⚠" : "✗"} ${name}: ${detail}${isBlocked ? `  [blocked: ${providerReason}]` : ""}`);
  if (!ok && warning) console.log(`    warning: ${warning}`);
  if (isBlocked) blocked++; else if (!ok) failed++;
};
// Stay under the free tier's requests-per-minute limit between live checks (SMOKE_GAP_MS, default 13 s).
const GAP_MS = Number(process.env.SMOKE_GAP_MS ?? 13_000);
const pause = () => new Promise(r => setTimeout(r, Number.isFinite(GAP_MS) && GAP_MS > 0 ? GAP_MS : 0));

// 1. Organizer: multi-step function calling → one Tier-1 batch
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, messages: [{ role: "user", text: "Cut ₹20k from decor and move the Haldi to Friday" }] }))).json();
  const batches = (r.actions ?? []).filter((a: { kind: string }) => a.kind === "batch");
  check("organizer chat", r.mode === "gemini" && batches.length > 0, `mode=${r.mode} batches=${batches.length} reply="${String(r.reply).slice(0, 90)}"`, r.warning, r.fallbackReason);
  for (const b of batches) console.log("   ", b.tier, b.log?.join(" | "));
}
await pause();
// 2. Organizer: over-cut → rollback + counter-offer
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, messages: [{ role: "user", text: "Cut ₹1.5L from decor" }] }))).json();
  const counter = (r.actions ?? []).some((a: { counterOffer?: boolean }) => a.counterOffer);
  check("over-cut counter-offer", r.mode === "gemini" && counter, `mode=${r.mode} counterOffer=${counter} reply="${String(r.reply).slice(0, 90)}"`, r.warning, r.fallbackReason);
}
await pause();
// 3. Guest: budget change must be refused by the reducer
{
  const r = await (await chat(post({ state: royalWedding, today: TODAY, role: "guest", actingGuestId: "g1", messages: [{ role: "user", text: "Cut ₹20k from decor" }] }))).json();
  const batches = (r.actions ?? []).filter((a: { kind: string }) => a.kind === "batch");
  check("guest boundary", r.mode === "gemini" && batches.length === 0, `mode=${r.mode} batches=${batches.length} reply="${String(r.reply).slice(0, 90)}"`, r.warning, r.fallbackReason);
}
await pause();
// 4 + 5. Vision: one real scan of the Deccan quote (saves quota), checked for the values and for staying a proposal
{
  const img = readFileSync("samples/deccan-royal-caterers-quote.png").toString("base64");
  const r = await (await scan(post({ state: royalWedding, today: TODAY, imageBase64: img, mimeType: "image/png" }))).json();
  const q = r.scanned ?? {};
  const why = r.source === "gemini" ? undefined : (r.error ?? r.source);
  check("vision quote scan", r.source === "gemini" && q.quotedPaise === 1_85_000_00,
    `source=${r.source} vendor=${q.vendorName} quoted=${q.quotedPaise} deposit=${q.depositRequiredPaise} due=${q.dueAt} flags=${(q.redFlags ?? []).length}`,
    r.warning ?? r.message ?? (r.source === "gemini" ? undefined : r.reply), why);
  const money = [q.quotedPaise, q.depositRequiredPaise].filter((v: unknown) => v !== undefined && v !== null);
  const ints = money.length > 0 && money.every((v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0);
  const batches = (r.actions ?? []).filter((a: { kind: string }) => a.kind === "batch");
  const tier1 = batches.length > 0 && batches.every((b: { tier?: number }) => b.tier === 1);
  check("scan is an approval proposal", r.source === "gemini" && ints && tier1,
    `source=${r.source} integerPaise=${ints} batches=${batches.length} tiers=${batches.map((b: { tier?: number }) => b.tier).join(",")}`, undefined, why);
}
// 6. Provider failure: a rejected key must fall back safely, say why, and never echo the key
{
  const real = process.env.GEMINI_API_KEY;
  const fake = "smoke-invalid-key-" + "x".repeat(24);
  process.env.GEMINI_API_KEY = fake;
  try {
    const raw = await (await chat(post({ state: royalWedding, today: TODAY, messages: [{ role: "user", text: "What's overdue?" }] }))).text();
    const r = JSON.parse(raw);
    const safe = r.mode === "offline" && typeof r.fallbackReason === "string" && typeof r.warning === "string" && !raw.includes(fake) && !raw.includes(KEY);
    check("provider failure is safe", safe, `mode=${r.mode} fallbackReason=${r.fallbackReason} warning="${String(r.warning).slice(0, 80)}"`);
  } finally { process.env.GEMINI_API_KEY = real; }
}
if (failed) console.log(`\nFAIL: ${failed} check(s) failed${blocked ? `, ${blocked} blocked by the provider` : ""}`);
else if (blocked) console.log(`\nBLOCKED: ${blocked} check(s) couldn't run because Gemini was rate-limited, overloaded or too slow. Nothing failed, but nothing here counts as passing. Free-tier limits reset at midnight Pacific.`);
else console.log("\nPASS: all live Gemini checks passed");
process.exitCode = failed ? 1 : blocked ? 2 : 0;
}
void main();
