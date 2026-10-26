// A small, deterministic phone normaliser with an India default (v8 Part 1). Guest lists are deduped by E.164 number,
// and the WhatsApp click-to-chat link needs the bare digits. libphonenumber-js would add ~150 KB of metadata to the
// client bundle for rules this app does not need: guests are overwhelmingly Indian mobiles, and anything written with
// a country code is accepted when its length is plausible for E.164 (8 to 15 digits). It never guesses a country for
// a number that is neither Indian-shaped nor written with a "+" or "00" prefix.

/** Country calling code used when a number has no prefix: India. */
export const DEFAULT_COUNTRY_CODE = "91";

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: string };

/** Separators people type inside a number: spaces (incl. non-breaking), dashes, dots, slashes, parentheses. */
const SEPARATORS = /[\s\u00a0\u2010-\u2015().\-/]/g;

/**
 * Normalise one phone number to E.164 ("+919848012345"). Accepted forms (India default):
 *   "98480 12345", "098480-12345", "+91 98480 12345", "91 9848012345", "0091 98480 12345", "tel:+91-98480-12345",
 *   and any other country written with "+" or "00" ("+1 415 555 0100", "0044 20 7946 0958").
 * Rejected: letters, extensions, too few or too many digits, Indian numbers that can't exist (leading 0 or 1).
 */
export function normalizePhone(raw: string, defaultCc: string = DEFAULT_COUNTRY_CODE): PhoneResult {
  let s = raw.trim().replace(/^tel:/i, "").replace(SEPARATORS, "");
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > 24) return { ok: false, reason: "too long" };
  let intl = false;
  if (s.startsWith("+")) { intl = true; s = s.slice(1); }
  else if (s.startsWith("00")) { intl = true; s = s.slice(2); }
  if (!/^\d+$/.test(s)) return { ok: false, reason: "not a phone number" };
  if (!intl) {
    // National forms for the default country (India): 10 digits, optionally with a trunk 0 or the bare country code.
    if (s.length === 11 && s.startsWith("0")) s = s.slice(1);
    else if (s.length === 12 && s.startsWith(defaultCc)) s = s.slice(defaultCc.length);
    if (s.length !== 10) return { ok: false, reason: s.length < 10 ? "too few digits" : "too many digits" };
    s = defaultCc + s;
  }
  if (s.length < 8 || s.length > 15) return { ok: false, reason: s.length < 8 ? "too few digits" : "too many digits" };
  if (s.startsWith("0")) return { ok: false, reason: "country code can't start with 0" };
  if (s.startsWith("91")) {
    const national = s.slice(2);
    if (national.length !== 10) return { ok: false, reason: "Indian numbers have 10 digits after +91" };
    if (!/^[2-9]/.test(national)) return { ok: false, reason: "Indian numbers start with 2 to 9" };
  }
  return { ok: true, e164: `+${s}` };
}

/** The E.164 form, or null when the input isn't a usable number. */
export const toE164 = (raw: string): string | null => { const r = normalizePhone(raw); return r.ok ? r.e164 : null; };

/** Digits only, as wa.me wants them ("+919848012345" → "919848012345"). */
export const waDigits = (e164: string) => e164.replace(/\D/g, "");

/** "+91 98480 12345" for Indian numbers, "+<digits>" otherwise. Display only. */
export function formatPhone(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** "+91 ••••• •2345": the last four digits only, for places where the number is a hint, not a value (approval cards). */
export function maskPhone(e164: string): string {
  if (!e164) return "";
  const tail = e164.slice(-4);
  return e164.startsWith("+91") ? `+91 ••••• •${tail}` : `+${e164.slice(1, 3)}••••${tail}`;
}

/** A phone-shaped run inside free text: an optional + or 00, then at least 8 digits with separators between them. */
export const PHONE_IN_TEXT = /(?:\+|\b00)?\d(?:[\s\u00a0().\-/]{0,2}\d){7,16}/g;
