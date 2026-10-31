"use client";
// v8 Part 1c: the organizer's RSVP dashboard, at the top of /guests. Every number comes from computeRsvpCounts (src/rsvp.ts,
// pure and unit-tested), never from the AI. The table searches by name or phone and filters by function, meal, answer, VIP
// and possible duplicates; each row has a VIP toggle, Remove (soft delete, with Undo and "Recently removed") and, on a
// possible duplicate, Merge. CSV export escapes spreadsheet formulas. Settings: the close date (IST) and the kids question.
// Every change is a reducer command through commit (source "ui"), so it is undoable like any other edit.
import { useId, useMemo, useState } from "react";
import { BarChart3, Check, Download, GitMerge, RefreshCw, RotateCcw, Settings2, Star, Trash2, Users, X } from "lucide-react";
import type { AgentState, RsvpAnswer, RsvpEntry, RsvpMeal } from "@/schema";
import { ANSWER_LABEL, ANSWERS, computeRsvpCounts, filterEntries, formatIst, MEAL_LABEL, MEALS, newestOf, removedEntries, rsvpCsv, rsvpFunctions, utcIsoToIst } from "@/rsvp";
import { formatPhone } from "@/phone";
import { usePlanner } from "./planner-context";
import { Badge, Card, Empty } from "./ui";

const field = "mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink";
const btn = "flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50";
const PAGE = 100;
const whenText = (at: string) => (at && !Number.isNaN(Date.parse(at)) ? formatIst(at).replace(/ IST$/, "") : "");

export default function RsvpDashboard() {
  const { plan, sharing } = usePlanner();
  const counts = useMemo(() => computeRsvpCounts(plan), [plan]);
  const syncing = sharing.status.state === "syncing";
  return (
    <section id="guests-rsvp" aria-labelledby="rsvp-dash-title" className="space-y-4" data-testid="rsvp-dashboard">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="rsvp-dash-title" className="flex items-center gap-2 text-lg font-semibold text-ink"><BarChart3 size={20} aria-hidden="true" className="text-brand-700" />RSVPs</h2>
        <span className="text-sm text-ink-muted" data-testid="rsvp-sync-note">{sharing.share ? "New answers arrive every 20 seconds, or now:" : "Publish the RSVP link to start collecting answers."}</span>
        {sharing.share && <button type="button" onClick={sharing.syncNow} disabled={syncing} data-testid="rsvp-refresh" className={btn}><RefreshCw size={15} aria-hidden="true" />{syncing ? "Checking…" : "Check for new RSVPs"}</button>}
      </div>
      <Totals plan={plan} counts={counts} />
      <PerFunction counts={counts} />
      <RsvpTable plan={plan} />
      <RsvpSettings plan={plan} />
    </section>
  );
}

type Counts = ReturnType<typeof computeRsvpCounts>;
function Tile({ label, value, sub, testId }: { label: string; value: number; sub?: string; testId: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-testid={testId} data-value={value}>
      <p className="text-xs font-semibold text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</p>
      {sub && <p className="text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}
function Totals({ plan, counts }: { plan: AgentState; counts: Counts }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="rsvp-totals">
      <Tile label="Coming" value={counts.coming.people} sub={`${counts.coming.entries} ${counts.coming.entries === 1 ? "family" : "families"}${counts.coming.kids !== null ? `, ${counts.coming.kids} kids` : ""}`} testId="rsvp-total-coming" />
      <Tile label="Maybe" value={counts.maybe.people} sub="Not in the catering total" testId="rsvp-total-maybe" />
      <Tile label="Not coming" value={counts.notComing.entries} sub={`${counts.notComing.entries === 1 ? "RSVP" : "RSVPs"}`} testId="rsvp-total-notcoming" />
      <Tile label="RSVPs" value={counts.totalEntries} sub={plan.rsvpSettings.closesAt ? `Closes ${formatIst(plan.rsvpSettings.closesAt)}` : "No close date"} testId="rsvp-total-entries" />
      <Tile label="Possible duplicates" value={counts.possibleDuplicates} sub={counts.possibleDuplicates ? "Counted until you merge or remove them" : "None to sort out"} testId="rsvp-total-dups" />
    </div>
  );
}

function PerFunction({ counts }: { counts: Counts }) {
  if (!counts.perFunction.length) return <Empty>No sub-event takes RSVPs yet. Turn on &quot;Collects RSVPs&quot; for a function on the Event page.</Empty>;
  const kids = counts.askKids;
  return (
    <Card id="guests-rsvp-counts" title="Headcount by function" icon={<Users size={18} className="text-emerald-700" />}
      subtitle="Coming people per function and meal, for the caterer. Maybe is shown on its own and never added to the total.">
      <div tabIndex={0} role="group" aria-label="Headcount by function" className="relative overflow-x-auto focus-visible:outline-offset-2">
        <table className="w-full min-w-[28rem] text-sm" data-testid="rsvp-fn-table">
          <thead className="text-left text-xs font-semibold text-ink-muted">
            <tr>
              <th scope="col" className="pb-2 pr-3">Function</th><th scope="col" className="px-2 pb-2 text-right">Coming</th>
              {kids && <th scope="col" className="px-2 pb-2 text-right">Kids</th>}
              {MEALS.map(m => <th key={m} scope="col" className="px-2 pb-2 text-right">{MEAL_LABEL[m]}</th>)}
              <th scope="col" className="pb-2 pl-3 text-right">Maybe</th>
            </tr>
          </thead>
          <tbody>
            {counts.perFunction.map(f => (
              <tr key={f.id} className="border-t border-line-soft" data-testid={`rsvp-fn-count-${f.id}`} data-coming={f.coming} data-maybe={f.maybe}
                data-veg={f.meals.veg} data-non-veg={f.meals.non_veg} data-jain={f.meals.jain} {...(kids ? { "data-kids": f.kids ?? 0 } : {})}>
                <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">{f.name}</th>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-ink">{f.coming}</td>
                {kids && <td className="px-2 py-2.5 text-right tabular-nums text-ink">{f.kids ?? 0}</td>}
                {MEALS.map(m => <td key={m} className="px-2 py-2.5 text-right tabular-nums text-ink">{f.meals[m]}</td>)}
                <td className="py-2.5 pl-3 text-right tabular-nums text-ink-muted">{f.maybe}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-muted" data-testid="rsvp-meals-total">Meals across the event (each coming family once): {MEALS.map(m => `${MEAL_LABEL[m]} ${counts.meals[m]}`).join(" · ")}</p>
    </Card>
  );
}

type Filter = { q: string; fn: string; meal: RsvpMeal | ""; answer: RsvpAnswer | ""; vip: boolean; duplicates: boolean };
function RsvpTable({ plan }: { plan: AgentState }) {
  const { commit } = usePlanner();
  const [f, setF] = useState<Filter>({ q: "", fn: "", meal: "", answer: "", vip: false, duplicates: false });
  const [limit, setLimit] = useState(PAGE);
  const [msg, setMsg] = useState<{ text: string; undo?: string } | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const id = useId();
  const fns = rsvpFunctions(plan);
  const rows = useMemo(() => filterEntries(plan, f), [plan, f]);
  const removed = removedEntries(plan);
  const fnName = (sid: string) => plan.subEvents.find(s => s.id === sid)?.name ?? "";
  const set = (patch: Partial<Filter>) => { setF(x => ({ ...x, ...patch })); setLimit(PAGE); };
  const run = (summary: string, command: Record<string, unknown> & { op: string }, ok: string, undo?: string) => {
    const r = commit({ summary, commands: [command as never] });
    setMsg(r.ok ? { text: ok, ...(undo ? { undo } : {}) } : { text: r.reason });
    return r.ok;
  };
  const remove = (e: RsvpEntry) => run(`Remove RSVP ${e.name}`, { op: "remove_rsvp_entry", entryId: e.id }, `Removed ${e.name}'s RSVP.`, e.id);
  const restore = (eid: string, name: string) => run(`Restore RSVP ${name}`, { op: "restore_rsvp_entry", entryId: eid }, `Restored ${name}'s RSVP.`);
  const csv = () => {
    const blob = new Blob([rsvpCsv(plan, rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rsvps-${plan.event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event"}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMsg({ text: `Downloaded ${rows.length} RSVP${rows.length === 1 ? "" : "s"} as CSV.` });
  };
  const live = plan.rsvpEntries.filter(e => !e.removedAt && !e.mergedInto).length;
  return (
    <Card id="guests-rsvp-list" title="RSVP list" icon={<Users size={18} className="text-maroon-700" />}
      subtitle="Only you see this list and the phone numbers. Guests never see each other's RSVPs.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm text-ink-muted sm:col-span-2">Search by name or phone
          <input type="search" value={f.q} onChange={e => set({ q: e.target.value })} data-testid="rsvp-search" className={field} />
        </label>
        <label className="text-sm text-ink-muted">Function
          <select value={f.fn} onChange={e => set({ fn: e.target.value })} data-testid="rsvp-filter-fn" className={field}>
            <option value="">All functions</option>
            {fns.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm text-ink-muted">Meal
          <select value={f.meal} onChange={e => set({ meal: e.target.value as RsvpMeal | "" })} data-testid="rsvp-filter-meal" className={field}>
            <option value="">All meals</option>
            {MEALS.map(m => <option key={m} value={m}>{MEAL_LABEL[m]}</option>)}
          </select>
        </label>
        <label className="text-sm text-ink-muted">Answer
          <select value={f.answer} onChange={e => set({ answer: e.target.value as RsvpAnswer | "" })} data-testid="rsvp-filter-answer" className={field}>
            <option value="">All answers</option>
            {ANSWERS.map(a => <option key={a} value={a}>{ANSWER_LABEL[a]}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
          <button type="button" aria-pressed={f.vip} onClick={() => set({ vip: !f.vip })} data-testid="rsvp-filter-vip" className={`${btn} ${f.vip ? "border-brand-700 bg-brand-50 text-brand-800" : ""}`}>
            {f.vip && <Check size={15} aria-hidden="true" />}VIP only</button>
          <button type="button" aria-pressed={f.duplicates} onClick={() => set({ duplicates: !f.duplicates })} data-testid="rsvp-filter-dup" className={`${btn} ${f.duplicates ? "border-brand-700 bg-brand-50 text-brand-800" : ""}`}>
            {f.duplicates && <Check size={15} aria-hidden="true" />}Possible duplicates</button>
          <button type="button" onClick={csv} disabled={rows.length === 0} data-testid="rsvp-csv" className={btn}><Download size={15} aria-hidden="true" />Download CSV</button>
        </div>
      </div>
      <p role="status" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted empty:hidden" data-testid="rsvp-list-msg">
        {msg && <>{msg.text}{msg.undo && <button type="button" onClick={() => { restore(msg.undo!, plan.rsvpEntries.find(e => e.id === msg.undo)?.name ?? "that"); }} data-testid="rsvp-undo" className={btn}><RotateCcw size={15} aria-hidden="true" />Undo</button>}</>}
      </p>
      <p className="mt-2 text-sm text-ink" id={`${id}-count`} data-testid="rsvp-shown">Showing {Math.min(rows.length, limit)} of {rows.length}{rows.length !== live ? ` (${live} in all)` : ""}</p>
      {live === 0 ? <Empty>No RSVPs yet. Share the RSVP link above: answers appear here.</Empty> : rows.length === 0 ? <Empty>No RSVP matches these filters.</Empty> : (
        <div tabIndex={0} role="group" aria-label="RSVP list" aria-describedby={`${id}-count`} className="relative mt-2 overflow-x-auto focus-visible:outline-offset-2">
          <table className="w-full min-w-[46rem] text-sm" data-testid="rsvp-table">
            <thead className="text-left text-xs font-semibold text-ink-muted">
              <tr><th scope="col" className="pb-2 pr-3">Name</th><th scope="col" className="pb-2 pr-3">Phone</th><th scope="col" className="px-2 pb-2 text-right">People</th>
                <th scope="col" className="pb-2 pr-3">Answer</th><th scope="col" className="pb-2 pr-3">Functions</th><th scope="col" className="pb-2 pr-3">Meal</th>
                <th scope="col" className="pb-2 pr-3">Updated (IST)</th><th scope="col" className="pb-2"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map(e => {
                const dupOf = e.possibleDuplicateOf ? plan.rsvpEntries.find(x => x.id === e.possibleDuplicateOf) : undefined;
                return (
                  <tr key={e.id} className="border-t border-line-soft align-top" data-testid={`rsvp-row-${e.id}`} data-answer={e.answer} data-party={e.partySize} data-dup={dupOf ? "true" : "false"}>
                    <td className="py-2.5 pr-3 font-medium text-ink">
                      <span className="flex flex-wrap items-center gap-1.5">{e.name}{e.vip && <Badge tone="primary"><Star size={12} aria-hidden="true" />VIP</Badge>}
                        {dupOf && <Badge tone="warning">possible duplicate of {dupOf.name}</Badge>}</span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-ink-muted">{e.phone ? formatPhone(e.phone) : "None"}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-ink">{e.partySize}{e.kids ? <span className="block text-xs text-ink-muted">{e.kids} kids</span> : null}</td>
                    <td className="py-2.5 pr-3 text-ink">{ANSWER_LABEL[e.answer]}</td>
                    <td className="py-2.5 pr-3 text-ink">{e.answer === "not_coming" ? "" : e.functions.map(fnName).filter(Boolean).join(", ")}</td>
                    <td className="py-2.5 pr-3 text-ink">{e.answer === "not_coming" ? "" : MEAL_LABEL[e.meal]}</td>
                    <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-ink-muted">{whenText(e.updatedAt || e.createdAt)}</td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" aria-pressed={e.vip} onClick={() => run(`${e.vip ? "Unmark" : "Mark"} VIP ${e.name}`, { op: "set_rsvp_vip", entryId: e.id, vip: !e.vip }, e.vip ? `${e.name} is no longer VIP.` : `${e.name} is VIP.`)}
                          data-testid={`rsvp-vip-${e.id}`} className={`${btn} ${e.vip ? "border-brand-700 bg-brand-50 text-brand-800" : ""}`}><Star size={15} aria-hidden="true" />VIP<span className="sr-only">: {e.name}</span></button>
                        {dupOf && <button type="button" onClick={() => setMerging(merging === e.id ? null : e.id)} aria-expanded={merging === e.id} data-testid={`rsvp-merge-${e.id}`} className={btn}><GitMerge size={15} aria-hidden="true" />Merge<span className="sr-only">: {e.name}</span></button>}
                        <button type="button" onClick={() => remove(e)} data-testid={`rsvp-remove-${e.id}`} className={btn}><Trash2 size={15} aria-hidden="true" className="text-red-700" />Remove<span className="sr-only">: {e.name}</span></button>
                      </span>
                      {merging === e.id && dupOf && <MergePanel a={e} b={dupOf} onDone={text => { setMerging(null); if (text) setMsg({ text }); }} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > limit && <button type="button" onClick={() => setLimit(l => l + PAGE)} data-testid="rsvp-more" className={`${btn} mt-2`}>Show {Math.min(PAGE, rows.length - limit)} more</button>}
        </div>
      )}
      {removed.length > 0 && (
        <details className="mt-4 rounded-xl border border-line p-3" data-testid="rsvp-removed-list">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink">Recently removed ({removed.length})</summary>
          <ul className="mt-2 divide-y divide-line-soft">
            {removed.map(e => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm" data-testid={`rsvp-removed-${e.id}`}>
                <span className="min-w-0 flex-1 text-ink">{e.name} <span className="text-ink-muted">· {e.partySize} · {ANSWER_LABEL[e.answer]}</span></span>
                <button type="button" onClick={() => restore(e.id, e.name)} data-testid={`rsvp-restore-${e.id}`} className={btn}><RotateCcw size={15} aria-hidden="true" />Restore<span className="sr-only">: {e.name}</span></button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** Merge two RSVPs for one family: keep the newest (default) or choose which answers to keep. */
function MergePanel({ a, b, onDone }: { a: RsvpEntry; b: RsvpEntry; onDone: (msg: string | null) => void }) {
  const { commit } = usePlanner();
  const newest = newestOf(a, b);
  const [keep, setKeep] = useState<"newest" | string>("newest");
  const id = useId();
  const keepId = keep === "newest" ? newest.id : keep;
  const dropId = keepId === a.id ? b.id : a.id;
  const label = (e: RsvpEntry) => `${e.name}: ${e.partySize}, ${ANSWER_LABEL[e.answer]}${e.answer !== "not_coming" ? `, ${MEAL_LABEL[e.meal]}` : ""}`;
  const go = () => {
    const kept = keepId === a.id ? a : b;
    const r = commit({ summary: `Merge RSVPs for ${kept.name}`, commands: [{ op: "merge_rsvp_entries", keepId, dropId }] });
    onDone(r.ok ? `Merged: kept ${kept.name} (${kept.partySize}).` : r.reason);
  };
  return (
    <fieldset className="mt-2 space-y-1.5 rounded-lg border border-line p-2 text-left" data-testid="rsvp-merge-panel">
      <legend className="px-1 text-sm font-semibold text-ink">Merge these two RSVPs</legend>
      {[["newest", `Keep the newest (${label(newest)})`], [a.id, `Keep ${label(a)}`], [b.id, `Keep ${label(b)}`]].map(([v, text]) => (
        <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="radio" name={`${id}-keep`} checked={keep === v} onChange={() => setKeep(v!)} className="h-5 w-5 accent-brand-700" data-testid={`rsvp-merge-keep-${v === "newest" ? "newest" : v}`} />{text}
        </label>
      ))}
      <span className="flex flex-wrap gap-2">
        <button type="button" onClick={go} data-testid="rsvp-merge-confirm" className={primary}><GitMerge size={15} aria-hidden="true" />Merge</button>
        <button type="button" onClick={() => onDone(null)} className={btn}><X size={15} aria-hidden="true" />Cancel</button>
      </span>
    </fieldset>
  );
}

/** The close date (picked in IST, stored as a UTC instant) and the kids question. */
function RsvpSettings({ plan }: { plan: AgentState }) {
  const { commit } = usePlanner();
  const cur = plan.rsvpSettings.closesAt ? utcIsoToIst(plan.rsvpSettings.closesAt) : null;
  const [date, setDate] = useState(cur?.date ?? "");
  const [time, setTime] = useState(cur?.time ?? "23:59");
  const [msg, setMsg] = useState<string | null>(null);
  const id = useId();
  const save = () => {
    if (!date) { setMsg("Pick a date first."); return; }
    const r = commit({ summary: "RSVP close date", commands: [{ op: "set_rsvp_settings", closesOn: date, closesTime: time || "23:59" }] });
    setMsg(r.ok ? `RSVPs close ${r.state.rsvpSettings.closesAt ? formatIst(r.state.rsvpSettings.closesAt) : ""}.` : r.reason);
  };
  const clear = () => {
    const r = commit({ summary: "Remove RSVP close date", commands: [{ op: "set_rsvp_settings", closesOn: null }] });
    if (r.ok) { setDate(""); setTime("23:59"); }
    setMsg(r.ok ? "No close date: RSVPs stay open." : r.reason);
  };
  const kids = plan.rsvpSettings.askKids;
  return (
    <Card id="guests-rsvp-settings" title="RSVP settings" icon={<Settings2 size={18} className="text-sand-700" />}
      subtitle="Times are India Standard Time. After the close date guests can still open the link, but can't change answers. To stop an old link, use Reset on the share card.">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-muted">Close date (IST)
          <input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="rsvp-close-date" aria-describedby={`${id}-now`} className={field} />
        </label>
        <label className="text-sm text-ink-muted">Time (IST)
          <input type="time" value={time} onChange={e => setTime(e.target.value)} data-testid="rsvp-close-time" className={field} />
        </label>
        <button type="button" onClick={save} data-testid="rsvp-close-save" className={primary}>Save close date</button>
        {plan.rsvpSettings.closesAt && <button type="button" onClick={clear} data-testid="rsvp-close-clear" className={btn}><X size={15} aria-hidden="true" />No close date</button>}
      </div>
      <p id={`${id}-now`} className="mt-2 text-sm text-ink" data-testid="rsvp-close-now">{plan.rsvpSettings.closesAt ? `RSVPs close ${formatIst(plan.rsvpSettings.closesAt)}.` : "RSVPs are open with no close date."}</p>
      <button type="button" aria-pressed={kids} onClick={() => { const r = commit({ summary: kids ? "Stop asking kids count" : "Ask kids count", commands: [{ op: "set_rsvp_settings", askKids: !kids }] }); setMsg(r.ok ? (kids ? "The form no longer asks about kids." : "The form now asks how many kids.") : r.reason); }}
        data-testid="rsvp-ask-kids" className={`${btn} mt-3 ${kids ? "border-brand-700 bg-brand-50 text-brand-800" : ""}`}>
        {kids && <Check size={15} aria-hidden="true" />}Ask kids count
      </button>
      <p role="status" className="mt-2 text-sm text-ink-muted empty:hidden" data-testid="rsvp-settings-msg">{msg}</p>
    </Card>
  );
}
