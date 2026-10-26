// v8 Part 1: turning a pasted list, a vCard file or picked phone contacts into one import_guests command.
// Everything here is pure and deterministic. The parsers only extract names, phones and emails; deciding what is new,
// a duplicate or invalid is planImport() in commands.ts, the same code the reducer runs, so the preview the organiser
// sees is exactly what Approve commits.
import type { z } from "zod";
import { GUEST_LIMITS, planImport, type BatchInput, type ImportEntry, type ImportPlan } from "./commands";
import { PHONE_IN_TEXT } from "./phone";
import type { AgentState } from "./schema";

export type ImportEntryInput = z.input<typeof ImportEntry>;
export type ParseIssue = { line: number; text: string; reason: string };
export type ParseResult = { entries: ImportEntryInput[]; issues: ParseIssue[]; truncated: boolean };
export type ImportSource = "paste" | "vcf" | "contacts" | "ai";

const EMAIL_IN_TEXT = /[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[A-Za-z]{2,}/;
/** List markers and separators left around a name: "1.", "-", "•", "*", ":", ",", "|", "–". */
const cleanName = (s: string) => s
  .replace(/^\s*(?:\d{1,3}[.)]\s+|[-*•·–—]\s*)/, "")
  .replace(/[<>()[\]{}"]/g, " ")
  .replace(/\b(?:mob(?:ile)?|ph(?:one)?|cell|tel|whatsapp|wa|no)\b\.?\s*:?/gi, " ")
  .replace(/^[\s,;:|\-–—]+|[\s,;:|\-–—]+$/g, "")
  .replace(/\s+/g, " ")
  .trim();

/** Normalise invisible and look-alike characters that phone contact apps and chat exports insert. */
const tidy = (s: string) => s.normalize("NFC").replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "").replace(/\u00a0/g, " ");

/**
 * Parse a pasted guest list. One person per line, in any of these shapes (and mixtures of them):
 *   "Ravi Kumar, +91 98480 12345"   "Sita - 9876543210"   "Anil: 098480-22222"   "+91 99999 11111 Lakshmi"
 *   "Meena <meena@example.com>"     "1. Arjun Rao 9848011111"   "Priya"  (no phone: still a guest)
 * A line holding several phones ("Ravi 98480 12345, Sita 98765 43210") is split at each phone. Lines may also be
 * separated by ";". Nothing is guessed: a line with no letters is reported, not imported.
 */
export function parsePasteList(text: string, max: number = GUEST_LIMITS.maxImport): ParseResult {
  const entries: ImportEntryInput[] = [], issues: ParseIssue[] = [];
  let truncated = false;
  const lines = tidy(text).split(/\r?\n|;/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    for (const piece of splitByPhones(line)) {
      if (entries.length >= max) { truncated = true; return; }
      const e = parsePiece(piece);
      if ("reason" in e) issues.push({ line: i + 1, text: piece.slice(0, 80), reason: e.reason });
      else entries.push(e);
    }
  });
  return { entries, issues, truncated };
}

/** "A 98480 12345, B 98765 43210" → ["A 98480 12345", "B 98765 43210"]; a name written after the only phone stays with it. */
function splitByPhones(line: string): string[] {
  const hits = [...line.matchAll(PHONE_IN_TEXT)];
  if (hits.length < 2) return [line];
  const out: string[] = [];
  let start = 0;
  for (const h of hits) {
    const end = h.index! + h[0].length;
    out.push(line.slice(start, end));
    start = end;
  }
  const rest = line.slice(start).trim();
  if (/[\p{L}]/u.test(rest)) out[out.length - 1] += ` ${rest}`; // trailing text after the last phone (e.g. an email)
  return out.map(s => s.replace(/^[\s,;|&]+|\band\b/gi, " ").trim()).filter(Boolean);
}

function parsePiece(piece: string): ImportEntryInput | { reason: string } {
  let rest = piece;
  const phone = rest.match(PHONE_IN_TEXT)?.[0];
  if (phone) rest = rest.replace(phone, " ");
  const email = rest.match(EMAIL_IN_TEXT)?.[0];
  if (email) rest = rest.replace(email, " ");
  const name = cleanName(rest);
  if (!/[\p{L}]/u.test(name)) return { reason: phone ? "No name next to this number" : "No name on this line" };
  if (name.length > 120) return { reason: "Name is longer than 120 characters" };
  return { name, ...(phone ? { phone: phone.trim() } : {}), ...(email ? { email } : {}) };
}

// ---------------------------------------------------------------- vCard (.vcf)
/** Largest .vcf the browser will read (a phone's whole address book is usually well under this). */
export const VCF_MAX_BYTES = 1024 * 1024;

/**
 * Parse a vCard 2.1 / 3.0 / 4.0 file: folded lines (a line starting with a space or tab continues the previous one),
 * several cards per file, FN (or N when FN is missing), TEL (the first CELL / pref number, else the first), EMAIL,
 * grouped properties ("item1.TEL"), backslash escapes and QUOTED-PRINTABLE values (with soft line breaks), which phones
 * still export for non-ASCII names. Cards with no usable name are reported, not imported.
 */
export function parseVcf(text: string, max: number = GUEST_LIMITS.maxImport): ParseResult {
  const entries: ImportEntryInput[] = [], issues: ParseIssue[] = [];
  let truncated = false;
  // Unfold: CRLF + whitespace continues a line; a QUOTED-PRINTABLE soft break "=" at line end also continues it.
  const unfolded = tidy(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/=\n/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  let card: { fn?: string; n?: string; tels: { v: string; pref: number }[]; email?: string } | null = null;
  let cardNo = 0;
  for (const line of lines) {
    const m = /^(?:[A-Za-z0-9-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line.trim());
    if (!m) continue;
    const prop = m[1]!.toUpperCase(), params = m[2]!.toUpperCase(), value = decodeValue(m[3]!, params);
    if (prop === "BEGIN" && value.toUpperCase() === "VCARD") { card = { tels: [] }; cardNo++; continue; }
    if (!card) continue;
    if (prop === "END" && value.toUpperCase() === "VCARD") {
      const name = (card.fn || nameFromN(card.n ?? "")).trim();
      const tel = [...card.tels].sort((a, b) => b.pref - a.pref)[0]?.v;
      if (!name || !/[\p{L}\p{N}]/u.test(name)) issues.push({ line: cardNo, text: tel ?? card.email ?? "(empty card)", reason: "Contact has no name" });
      else if (entries.length >= max) truncated = true;
      else entries.push({ name: name.slice(0, 120), ...(tel ? { phone: tel } : {}), ...(card.email ? { email: card.email } : {}) });
      card = null;
      continue;
    }
    if (prop === "FN") card.fn = unescapeText(value);
    else if (prop === "N") card.n = value;
    else if (prop === "TEL" && value.trim()) {
      const pref = /\bPREF\b|PREF=1/.test(params) ? 2 : /CELL|MOBILE|IPHONE/.test(params) ? 1 : 0;
      card.tels.push({ v: value.replace(/^tel:/i, "").trim(), pref });
    } else if (prop === "EMAIL" && !card.email && value.includes("@")) card.email = unescapeText(value).trim();
  }
  return { entries, issues, truncated };
}

/** N is "Family;Given;Additional;Prefix;Suffix". */
function nameFromN(n: string): string {
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitUnescaped(n);
  return [prefix, given, additional, family, suffix].map(s => s.trim()).filter(Boolean).join(" ");
}
function splitUnescaped(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i]! + s[i + 1]!; i++; continue; }
    if (s[i] === ";") { out.push(unescapeText(cur)); cur = ""; continue; }
    cur += s[i];
  }
  out.push(unescapeText(cur));
  return out;
}
const unescapeText = (s: string) => s.replace(/\\([nN])/g, " ").replace(/\\([,;:\\])/g, "$1");
function decodeValue(raw: string, params: string): string {
  let v = raw;
  if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/.test(params)) {
    const bytes: number[] = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "=" && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(v.charCodeAt(i) & 0xff);
    }
    v = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
  return v; // FN and EMAIL are unescaped where they are read; N keeps its ";" structure for splitUnescaped
}

// ---------------------------------------------------------------- Contact Picker API (Android Chrome)
type PickedContact = { name?: string[]; tel?: string[]; email?: string[] };
type ContactsManager = { select: (props: string[], opts: { multiple: boolean }) => Promise<PickedContact[]>; getProperties?: () => Promise<string[]> };
/** True only where navigator.contacts.select exists (Chrome on Android, secure origin). The button is hidden elsewhere. */
export function contactPickerSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const n = navigator as Navigator & { contacts?: ContactsManager };
  return !!n.contacts && typeof n.contacts.select === "function" && "ContactsManager" in window && window.isSecureContext;
}
/** Open the system contact picker. Returns [] when the organiser cancels. */
export async function pickContacts(): Promise<ImportEntryInput[]> {
  const n = navigator as Navigator & { contacts?: ContactsManager };
  if (!n.contacts) return [];
  const picked = await n.contacts.select(["name", "tel", "email"], { multiple: true });
  return contactsToEntries(picked);
}
/** Contact Picker results → import entries (first name, first phone, first email). Pure, for tests. */
export function contactsToEntries(picked: PickedContact[], max: number = GUEST_LIMITS.maxImport): ImportEntryInput[] {
  const out: ImportEntryInput[] = [];
  for (const c of picked) {
    const name = c.name?.map(s => s.trim()).find(Boolean);
    if (!name || out.length >= max) continue;
    const phone = c.tel?.map(s => s.trim()).find(Boolean), email = c.email?.map(s => s.trim()).find(Boolean);
    out.push({ name: name.slice(0, 120), ...(phone ? { phone } : {}), ...(email ? { email } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- preview → one batch
export type ImportPreview = ImportPlan & { entries: ImportEntryInput[]; batch: BatchInput | null };
/** What the import would do, and the single Tier 1 batch that does it (null when nothing is new). */
export function previewImport(plan: AgentState, entries: ImportEntryInput[], source: ImportSource): ImportPreview {
  const p = planImport(plan, entries);
  const fresh = entries.filter((_, i) => p.rows[i]!.status === "new");
  const batch: BatchInput | null = fresh.length ? {
    summary: `Import ${fresh.length} guest${fresh.length === 1 ? "" : "s"}${source === "vcf" ? " from contacts file" : source === "contacts" ? " from phone contacts" : source === "ai" ? "" : " from a pasted list"}`,
    // Every entry goes in, duplicates too: the reducer skips the same ones again, so a list that changed since the
    // preview (someone added meanwhile) is still deduped against the plan as it is when Approve is pressed.
    commands: [{ op: "import_guests", source, entries }],
  } : null;
  return { ...p, entries, batch };
}
