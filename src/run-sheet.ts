// v8 Part 1e: the birthday party run-sheet clock. Pure minutes arithmetic on "HH:MM" strings: no Date, no time zone,
// so the times never shift with the browser's or the server's clock. Code computes every start and end; the LLM never does.

export const MINUTES_PER_DAY = 1440;
/** A 24-hour "HH:MM" clock time, the format partyStart is stored in. */
export const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "19:30" → 1170 minutes after midnight; null when it isn't a valid HH:MM. */
export function parseHHMM(s: string | null | undefined): number | null {
  const m = s ? HHMM_RE.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after midnight (any integer, wrapping past midnight either way) → "7:05 PM", "12:15 AM", "12:00 PM". */
export function formatClock(min: number): string {
  const m = ((Math.trunc(min) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export type RowTime = {
  /** Minutes from the party's own midnight; may run past 1440 when the party goes past midnight. */
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  /** "7:00 PM to 7:45 PM" */
  label: string;
  /** True when this row ends after midnight (on the next day). */
  pastMidnight: boolean;
};

/** Sum of the rows' minutes. */
export const runSheetTotal = (rows: readonly { durationMin: number }[]): number => rows.reduce((a, r) => a + r.durationMin, 0);

/**
 * Start and end of each row, back to back from partyStart, in order. null without a valid partyStart (the run-sheet
 * then shows durations only).
 */
export function computeRunSheetTimes(partyStart: string | null | undefined, rows: readonly { durationMin: number }[]): RowTime[] | null {
  const start = parseHHMM(partyStart);
  if (start === null) return null;
  let t = start;
  return rows.map(r => {
    const s = t, e = t + r.durationMin;
    t = e;
    return { startMin: s, endMin: e, start: formatClock(s), end: formatClock(e), label: `${formatClock(s)} to ${formatClock(e)}`, pastMidnight: e > MINUTES_PER_DAY };
  });
}

/** When the last row ends, or null without a start time. */
export function runSheetEnd(partyStart: string | null | undefined, rows: readonly { durationMin: number }[]): string | null {
  const start = parseHHMM(partyStart);
  return start === null ? null : formatClock(start + runSheetTotal(rows));
}

/** The editor's input limits (the same numbers as ACTIVITY_LIMITS in commands.ts, which the reducer enforces). */
export const RUN_SHEET_INPUT = { minDuration: 5, maxDuration: 480, maxAge: 100 } as const;
/** "5-12", "5 to 12", "8+", "all" → the update_activity age fields; an error message otherwise. */
export function parseAges(raw: string): { ok: true; ageMin: number | null; ageMax: number | null } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase();
  if (v === "all" || v === "any" || v === "all ages") return { ok: true, ageMin: null, ageMax: null };
  const plus = /^(\d{1,3})\s*\+$/.exec(v);
  const range = /^(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})$/.exec(v);
  const lo = plus ? Number(plus[1]) : range ? Number(range[1]) : NaN, hi = plus ? RUN_SHEET_INPUT.maxAge : range ? Number(range[2]) : NaN;
  if (Number.isNaN(lo) || lo > RUN_SHEET_INPUT.maxAge || hi > RUN_SHEET_INPUT.maxAge) return { ok: false, error: `Enter ages like 5-12, 8+ or all (0 to ${RUN_SHEET_INPUT.maxAge}).` };
  if (lo > hi) return { ok: false, error: "The youngest age can't be above the oldest." };
  return { ok: true, ageMin: lo, ageMax: hi };
}
/** "45", "45 min" → 45; an error message outside 5–480. */
export function parseMinutes(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const m = /^(\d{1,3})\s*(?:m|min|mins|minutes?)?$/i.exec(raw.trim());
  const n = m ? Number(m[1]) : NaN;
  if (Number.isNaN(n) || n < RUN_SHEET_INPUT.minDuration || n > RUN_SHEET_INPUT.maxDuration) return { ok: false, error: `Enter whole minutes from ${RUN_SHEET_INPUT.minDuration} to ${RUN_SHEET_INPUT.maxDuration}.` };
  return { ok: true, value: n };
}
