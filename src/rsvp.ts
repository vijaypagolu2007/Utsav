// v8 Part 1c: the open RSVP list. Pure helpers shared by the reducer, the server, the organizer dashboard, the Co-Pilot's
// read-only headcount tool and the tests. Every count is computed here, in code: the LLM never adds up guests.
//
// Time: the close date is stored as a UTC instant and shown in India Standard Time. IST is a fixed UTC+05:30 (no daylight
// saving), so the conversion is plain arithmetic and gives the same answer on every machine, whatever its own zone.
import type { AgentState, RsvpAnswer, RsvpEntry, RsvpMeal, SubEvent } from "./schema";

export const IST_OFFSET_MIN = 330;
export const RSVP_CLOSED_MESSAGE = "RSVP period has ended";
export const RSVP_REMOVED_MESSAGE = "This RSVP was removed by the organizer. Please contact them if this is a mistake.";
export const RSVP_DUPLICATE_MESSAGE = "We already have an RSVP for this number. The organizer will sort it out.";
export const MEALS: readonly RsvpMeal[] = ["veg", "non_veg", "jain"];
export const ANSWERS: readonly RsvpAnswer[] = ["coming", "maybe", "not_coming"];
export const MEAL_LABEL: Record<RsvpMeal, string> = { veg: "Veg", non_veg: "Non-veg", jain: "Jain" };
export const ANSWER_LABEL: Record<RsvpAnswer, string> = { coming: "Coming", maybe: "Maybe", not_coming: "Not coming" };
/** The id pattern of an RSVP entry (the server makes them; Guest View previews make their own). */
export const RSVP_ENTRY_ID = /^r-[A-Za-z0-9_-]{4,40}$/;

/** The functions a guest can choose on the form: every sub-event that collects RSVPs, in date and time order. */
export function rsvpFunctions(plan: AgentState): SubEvent[] {
  return plan.subEvents.filter(s => s.collectsRsvp).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.id.localeCompare(b.id));
}
/** Entries that count: not removed and not merged into another entry. */
export const liveEntries = (plan: AgentState): RsvpEntry[] => plan.rsvpEntries.filter(e => !e.removedAt && !e.mergedInto);
/** "Recently removed": removed by the organizer (not merged away), newest first. */
export const removedEntries = (plan: AgentState): RsvpEntry[] =>
  plan.rsvpEntries.filter(e => e.removedAt && !e.mergedInto).sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? ""));

export type MealCounts = Record<RsvpMeal, number>;
export type FunctionCount = {
  id: string; slug: string; name: string; date: string;
  /** Catering headcount: the sum of party sizes of Coming entries that chose this function. */
  coming: number;
  /** Children among them (null when the organizer doesn't ask for a kids count). */
  kids: number | null;
  /** Coming people per meal, for this function. */
  meals: MealCounts;
  /** Maybe people for this function: shown separately, never added to the catering total. */
  maybe: number;
  /** Coming entries (parties) for this function. */
  entries: number;
};
export type RsvpCounts = {
  /** Live entries (any answer). */
  totalEntries: number;
  coming: { entries: number; people: number; kids: number | null };
  maybe: { entries: number; people: number };
  notComing: { entries: number; people: number };
  /** Coming people per meal, across the whole event (each party counted once). */
  meals: MealCounts;
  perFunction: FunctionCount[];
  vip: number;
  possibleDuplicates: number;
  removed: number;
  askKids: boolean;
};

const zeroMeals = (): MealCounts => ({ veg: 0, non_veg: 0, jain: 0 });

/** The RSVP dashboard's numbers. Pure: the same plan always gives the same counts. */
export function computeRsvpCounts(plan: AgentState): RsvpCounts {
  const askKids = plan.rsvpSettings.askKids;
  const live = liveEntries(plan);
  const fns = rsvpFunctions(plan);
  const kidsOf = (e: RsvpEntry) => Math.min(e.kids ?? 0, e.partySize);
  const sum = (xs: RsvpEntry[], f: (e: RsvpEntry) => number) => xs.reduce((a, e) => a + f(e), 0);
  const coming = live.filter(e => e.answer === "coming");
  const maybe = live.filter(e => e.answer === "maybe");
  const notComing = live.filter(e => e.answer === "not_coming");
  const meals = zeroMeals();
  for (const e of coming) meals[e.meal] += e.partySize;
  const perFunction = fns.map<FunctionCount>(s => {
    const here = coming.filter(e => e.functions.includes(s.id));
    const m = zeroMeals();
    for (const e of here) m[e.meal] += e.partySize;
    return { id: s.id, slug: s.slug, name: s.name, date: s.date, coming: sum(here, e => e.partySize), kids: askKids ? sum(here, kidsOf) : null, meals: m,
      maybe: sum(maybe.filter(e => e.functions.includes(s.id)), e => e.partySize), entries: here.length };
  });
  return {
    totalEntries: live.length,
    coming: { entries: coming.length, people: sum(coming, e => e.partySize), kids: askKids ? sum(coming, kidsOf) : null },
    maybe: { entries: maybe.length, people: sum(maybe, e => e.partySize) },
    notComing: { entries: notComing.length, people: sum(notComing, e => e.partySize) },
    meals, perFunction,
    vip: live.filter(e => e.vip).length,
    possibleDuplicates: live.filter(e => e.possibleDuplicateOf).length,
    removed: removedEntries(plan).length,
    askKids,
  };
}

// ---------- the close date, in IST ----------
const pad = (n: number) => String(n).padStart(2, "0");
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "2026-11-20" + "23:59" in IST → the UTC instant "2026-11-20T18:29:00.000Z". Null for an impossible date or time. */
export function istToUtcIso(date: string, time = "23:59"): string | null {
  const d = DATE_RE.exec(date), t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const ms = Date.UTC(y, mo - 1, da, Number(t[1]), Number(t[2])) - IST_OFFSET_MIN * 60_000;
  const check = new Date(Date.UTC(y, mo - 1, da));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da) return null;
  return new Date(ms).toISOString();
}
/** A UTC instant → its IST calendar date and wall time ({ date: "2026-11-20", time: "23:59" }). */
export function utcIsoToIst(iso: string): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + IST_OFFSET_MIN * 60_000);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Nov 2026, 11:59 PM IST". Built by hand (no Intl), so the server, the browser and the tests all agree. */
export function formatIst(iso: string): string {
  const p = utcIsoToIst(iso);
  if (!p) return iso;
  const [y, m, d] = p.date.split("-").map(Number) as [number, number, number];
  const [h, mi] = p.time.split(":").map(Number) as [number, number];
  return `${d} ${MONTHS[m - 1]} ${y}, ${((h + 11) % 12) + 1}:${pad(mi)} ${h < 12 ? "AM" : "PM"} IST`;
}
/** True once the close date has passed (writes are refused from that instant on). No close date: never closed. */
export function rsvpClosed(settings: AgentState["rsvpSettings"], nowIso: string): boolean {
  if (!settings.closesAt) return false;
  const close = Date.parse(settings.closesAt), now = Date.parse(nowIso);
  return !Number.isNaN(close) && !Number.isNaN(now) && now >= close;
}

// ---------- CSV export (organizer only) ----------
/**
 * One CSV cell. A cell a spreadsheet would run as a formula (it starts with = + - @, or a tab or carriage return, the
 * OWASP list) gets a leading apostrophe, so it is shown as text. Then the usual quoting for commas, quotes and newlines.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const RSVP_CSV_HEADER = ["Name", "Phone", "Party size", "Kids", "Answer", "Functions", "Meal", "VIP", "Possible duplicate of", "Updated (IST)"];
/** The organizer's RSVP list as CSV: live entries in the table's order (newest first). CRLF line ends, as Excel likes. */
export function rsvpCsv(plan: AgentState, entries: RsvpEntry[] = liveEntries(plan)): string {
  const fnName = new Map(plan.subEvents.map(s => [s.id, s.name]));
  const byId = new Map(plan.rsvpEntries.map(e => [e.id, e.name]));
  const rows = entries.map(e => [e.name, e.phone, e.partySize, plan.rsvpSettings.askKids ? e.kids ?? 0 : "", ANSWER_LABEL[e.answer],
    e.functions.map(f => fnName.get(f) ?? f).join("; "), MEAL_LABEL[e.meal], e.vip ? "yes" : "",
    e.possibleDuplicateOf ? byId.get(e.possibleDuplicateOf) ?? e.possibleDuplicateOf : "", e.updatedAt ? formatIst(e.updatedAt) : ""]);
  return [RSVP_CSV_HEADER, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Search and filters for the organizer's table. Phone search matches digits anywhere in the number. */
export type RsvpFilter = { q?: string; fn?: string; meal?: RsvpMeal | ""; answer?: RsvpAnswer | ""; vip?: boolean; duplicates?: boolean };
export function filterEntries(plan: AgentState, f: RsvpFilter): RsvpEntry[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return liveEntries(plan).filter(e =>
    (!q || e.name.toLowerCase().includes(q) || (digits.length >= 3 && e.phone.replace(/\D/g, "").includes(digits))) &&
    (!f.fn || e.functions.includes(f.fn)) && (!f.meal || e.meal === f.meal) && (!f.answer || e.answer === f.answer) &&
    (!f.vip || e.vip) && (!f.duplicates || !!e.possibleDuplicateOf),
  ).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt) || a.id.localeCompare(b.id));
}

/** Which of two duplicate entries "Keep newest" keeps: the later update (ties: the later-created one). */
export function newestOf(a: RsvpEntry, b: RsvpEntry): RsvpEntry {
  const ka = a.updatedAt || a.createdAt, kb = b.updatedAt || b.createdAt;
  return kb > ka ? b : ka > kb ? a : (b.createdAt > a.createdAt ? b : a);
}

/** The headcount answer the Co-Pilot reads (no names, no phones): what the read-only get_rsvp_counts tool returns. */
export function rsvpCountsForAi(plan: AgentState): Record<string, unknown> {
  const c = computeRsvpCounts(plan);
  return {
    note: "Computed in code from the open RSVP list. Catering totals count Coming parties only; Maybe is separate.",
    totalEntries: c.totalEntries, coming: c.coming, maybe: c.maybe, notComing: c.notComing, mealsComing: c.meals,
    perFunction: c.perFunction.map(f => ({ slug: f.slug, name: f.name, coming: f.coming, kids: f.kids, meals: f.meals, maybe: f.maybe })),
    possibleDuplicates: c.possibleDuplicates, vip: c.vip,
    closesAt: plan.rsvpSettings.closesAt ? formatIst(plan.rsvpSettings.closesAt) : null,
  };
}
