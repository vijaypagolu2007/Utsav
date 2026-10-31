"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Camera, CheckCircle2, ChevronDown, ChevronRight, CircleDollarSign, FileText, FileWarning, Lock, Plus, Scale, Scissors, Store, Trash2, TrendingUp, Unlock, Wallet, X } from "lucide-react";
import { SAMPLE_QUOTES } from "@/quote-scanner";
import { BUDGET_CATEGORIES, type AgentState, type BudgetItem } from "@/schema";
import { categoryMaxCuttable, plannedTotal, type BatchInput } from "@/commands";
import ApprovalPreview from "./ApprovalPreview";
import { parseInline } from "./ui";
import type { Commit, Highlight, ScanInput } from "./PlannerApp";
import { Card, Chip, FigureTag, InlineEdit, inr, longDate, saveWith, useHighlight } from "./ui";
import { FixByPriorities } from "./BudgetPlanning";
import { figureKind } from "@/vendors";
import { envelopeA11y } from "@/budget-a11y";
import { refAnchor } from "@/routes";

const CAT_LABEL: Record<string, string> = {
  venue: "Venue", catering: "Catering", decor: "Decor", photo_video: "Photo & video", music: "Music", attire: "Attire",
  beauty: "Beauty", stationery: "Stationery", gifts: "Gifts", logistics: "Logistics", permits: "Permits", entertainment: "Entertainment", misc: "Misc",
};

// Segment styles, shared by the bars and the legend. Each has its own pattern as well as its colour (WCAG 1.4.1),
// and every colour is at least 3:1 against the white card (1.4.11).
const SEG = {
  committed: "bg-sand-700",
  slack: "bg-emerald-600 pat-stripes",
  locked: "bg-sand-500 pat-stripes",
  over: "bg-red-600 pat-cross",
} as const;

function EnvelopeBar({ b }: { b: BudgetItem }) {
  const scale = Math.max(b.plannedPaise, b.quotedPaise ?? 0, b.committedPaise, 1);
  const c = (Math.min(b.committedPaise, b.plannedPaise) / scale) * 100;
  const s = (Math.max(0, b.plannedPaise - b.committedPaise) / scale) * 100;
  const over = b.committedPaise > b.plannedPaise ? ((b.committedPaise - b.plannedPaise) / scale) * 100 : 0;
  const q = b.quotedPaise !== null ? (b.quotedPaise / scale) * 100 : null;
  // The segments are decorative; the whole bar carries one description (a meter of committed spend against the
  // planned envelope, or a labelled image when nothing is planned). The same numbers are printed under the bar.
  const a = envelopeA11y(b);
  const sem = a.role === "meter"
    ? { role: "meter", "aria-label": a.label, "aria-valuenow": a.valueNow, "aria-valuemin": a.valueMin, "aria-valuemax": a.valueMax, "aria-valuetext": a.valueText }
    : { role: "img", "aria-label": a.label };
  return (
    <div {...sem} data-testid={`envelope-${b.id}`} className="relative h-3 w-full rounded-full bg-sand-100 ring-1 ring-inset ring-sand-400" title="solid dark = committed · striped green = cuttable · striped grey = locked · cross-hatched red = over plan · tick = quote">
      <div className="absolute inset-0 overflow-hidden rounded-full">
        <div aria-hidden="true" className={`absolute inset-y-0 left-0 ${SEG.committed}`} style={{ width: `${c}%` }} />
        <div aria-hidden="true" className={`absolute inset-y-0 ${b.locked ? SEG.locked : SEG.slack}`} style={{ left: `${c}%`, width: `${s}%` }} />
        {over > 0 && <div aria-hidden="true" className={`absolute inset-y-0 ${SEG.over}`} style={{ left: `${c + s}%`, width: `${over}%` }} />}
      </div>
      {q !== null && <div aria-hidden="true" className={`absolute -inset-y-1 w-1 rounded-full ${b.quotedPaise! > b.plannedPaise ? "bg-amber-700" : "bg-peacock-700"}`} style={{ left: `calc(${Math.min(q, 100)}% - 2px)` }} />}
    </div>
  );
}

function Legend() {
  const sw = "inline-block h-3 w-5 rounded-sm ring-1 ring-inset ring-sand-400";
  return (
    <ul aria-label="Bar legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
      <li className="flex items-center gap-1.5"><i aria-hidden="true" className={`${sw} ${SEG.committed}`} />Committed</li>
      <li className="flex items-center gap-1.5"><i aria-hidden="true" className={`${sw} ${SEG.slack}`} />Cuttable</li>
      <li className="flex items-center gap-1.5"><i aria-hidden="true" className={`${sw} ${SEG.locked}`} />Locked</li>
      <li className="flex items-center gap-1.5"><i aria-hidden="true" className={`${sw} ${SEG.over}`} />Over plan</li>
      <li className="flex items-center gap-1.5"><i aria-hidden="true" className="inline-block h-4 w-1 rounded-full bg-amber-700" />Quote</li>
    </ul>
  );
}

const btnBase = "flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

function ScanZone({ plan, onScan, busy }: { plan: AgentState; onScan: (i: ScanInput) => void; busy: boolean }) {
  const [drag, setDrag] = useState(false);
  const mine = SAMPLE_QUOTES.find(q => q.archetype === plan.event.eventType) ?? SAMPLE_QUOTES[0];
  const others = SAMPLE_QUOTES.filter(q => q.id !== mine.id);
  const take = (f: File | undefined) => { if (f) onScan({ file: f }); };
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]); }}
      className={`mb-6 rounded-xl border-2 border-dashed p-4 transition sm:p-5 ${drag ? "border-brand-600 bg-brand-50" : "border-sand-300 bg-canvas"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* A real button opens the file picker, so the action is reachable by keyboard (a <label> around a hidden input is not). */}
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className={`${btnBase} min-h-10 bg-maroon-800 text-white hover:bg-maroon-900 max-md:min-h-11`}>
          <Camera size={16} aria-hidden="true" /> Scan Vendor Quote / Invoice
        </button>
        <input ref={fileRef} type="file" accept="image/*,application/pdf,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" data-testid="ledger-upload"
          onChange={e => { take(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" disabled={busy} onClick={() => onScan({ sampleId: mine.id })}
          className={`${btnBase} min-h-10 bg-primary text-white hover:bg-primary-hover max-md:min-h-11`}>
          <FileText size={16} aria-hidden="true" /> Scan Sample Vendor Quote
        </button>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-ink-muted">
        <span>Or drop an image or PDF here. Other samples:</span>
        {others.map(q => (
          <button key={q.id} type="button" disabled={busy} onClick={() => onScan({ sampleId: q.id })}
            className="min-h-8 rounded-md px-1.5 font-medium text-brand-800 underline underline-offset-2 hover:bg-brand-50 max-md:min-h-11">{q.title.split(" — ")[0]}</button>
        ))}
      </p>
    </div>
  );
}

/** Total budget (editable), planned, headroom, and "Rebalance to my total" previewed as an approval card. */
function BudgetTotals({ plan, commit }: { plan: AgentState; commit: Commit }) {
  const [preview, setPreview] = useState<BatchInput | null>(null);
  const total = plan.event.totalBudgetPaise, planned = plannedTotal(plan), head = total - planned;
  const committed = plan.budgetItems.reduce((a, b) => a + b.committedPaise, 0);
  return (
    <div className="mb-4 space-y-3" data-testid="budget-totals">
      <dl className="grid gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm tabular-nums sm:grid-cols-3 sm:p-4">
        <div className="min-w-0">
          <dt className="text-ink-muted">Total budget</dt>
          <dd><InlineEdit label="total budget" kind="rupees" value={String(total / 100)} inputSize="w-40" testId="edit-total-budget"
            onSave={(paise: number) => paise === total ? null : saveWith(commit, { summary: `Total budget → ${inr(paise)}`, commands: [{ op: "set_event_basics", totalBudgetPaise: paise }] })}>
            <span data-testid="budget-total" className="text-lg font-semibold text-ink">{inr(total)}</span>
          </InlineEdit></dd>
        </div>
        <div><dt className="text-ink-muted">Planned across lines</dt><dd data-testid="budget-planned" className="text-lg font-semibold text-ink">{inr(planned)}</dd><dd className="text-ink-muted">{inr(committed)} committed</dd></div>
        <div>
          <dt className="text-ink-muted">{head >= 0 ? "Not yet planned" : "Over the total"}</dt>
          <dd data-testid="budget-headroom" className={`text-lg font-semibold ${head < 0 ? "text-red-700" : "text-ink"}`}>{inr(Math.abs(head))}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={head === 0} aria-expanded={!!preview} data-testid="rebalance"
          onClick={() => setPreview(p => p ? null : { summary: `Rebalance planned envelopes to the ${inr(total)} total`, commands: [{ op: "rebalance_budget", expectedHeadroomPaise: head }] })}
          className="flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-sand-800 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11">
          <Scale size={16} aria-hidden="true" />Rebalance to my total
        </button>
        <span className="text-sm text-ink-muted">{head === 0 ? "Planned already matches your total." : head > 0 ? "Spreads what's not planned across unlocked lines, in proportion (protected categories first, when set)." : "Trims unlocked, uncommitted money (by your priorities, when set)."}</span>
      </div>
      <FixByPriorities plan={plan} commit={commit} />
      {preview && <ApprovalPreview plan={plan} batch={preview} label="Review: rebalance to your total" onCancel={() => setPreview(null)}
        onApprove={() => { const r = commit(preview); if (r.ok) setPreview(null); }} />}
    </div>
  );
}

/** "Add a line": a new budget line (or the first line of a new category) through add_budget_item. */
function AddLineForm({ plan, commit, onAdded }: { plan: AgentState; commit: Commit; onAdded: (cat: string) => void }) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<BudgetItem["category"]>("decor");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [sub, setSub] = useState("");
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const field = "mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink";
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} data-testid="add-budget-line"
      className="flex min-h-10 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-white hover:bg-primary-hover max-md:min-h-11">
      <Plus size={16} aria-hidden="true" />Add category or line
    </button>
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = parseInline("text", label);
    if (!name.ok) { setError("Give the line a name, like Mehendi artist."); return; }
    const amt = parseInline("rupees", amount);
    if (!amt.ok) { setError(amt.error); return; }
    const r = commit({ summary: `Add ${CAT_LABEL[cat]?.toLowerCase() ?? cat} line "${name.value}"`, commands: [{ op: "add_budget_item", category: cat, label: name.value as string,
      plannedPaise: amt.value as number, ...(sub ? { subEvent: sub } : {}), ...(booked ? { alreadyBooked: true } : {}) }] });
    if (!r.ok) { setError(r.reason); return; }
    setOpen(false); setLabel(""); setAmount(""); setBooked(false); setError(null); onAdded(cat);
  };
  return (
    <form noValidate onSubmit={submit} aria-labelledby={`${id}-h`} data-testid="add-line-form" className="rounded-lg border border-line bg-surface-muted p-4">
      <h3 id={`${id}-h`} className="text-base font-semibold text-ink">Add a budget line</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><label htmlFor={`${id}-cat`} className="text-sm font-medium text-ink">Category</label>
          <select id={`${id}-cat`} value={cat} onChange={e => setCat(e.target.value as BudgetItem["category"])} className={field}>
            {BUDGET_CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c] ?? c}</option>)}
          </select></div>
        <div><label htmlFor={`${id}-name`} className="text-sm font-medium text-ink">Line name</label>
          <input id={`${id}-name`} value={label} onChange={e => setLabel(e.target.value)} maxLength={120} placeholder="e.g. Mehendi artist" className={field} /></div>
        <div><label htmlFor={`${id}-amt`} className="text-sm font-medium text-ink">Planned amount (₹)</label>
          <input id={`${id}-amt`} value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" className={`${field} tabular-nums`} /></div>
        <div><label htmlFor={`${id}-sub`} className="text-sm font-medium text-ink">For</label>
          <select id={`${id}-sub`} value={sub} onChange={e => setSub(e.target.value)} className={field}>
            <option value="">The whole event</option>
            {plan.subEvents.map(se => <option key={se.id} value={se.id}>{se.name}</option>)}
          </select></div>
      </div>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" checked={booked} onChange={e => setBooked(e.target.checked)} className="h-6 w-6 shrink-0 accent-brand-700" />Already booked (commit and lock this amount)</label>
      {error && <p role="alert" className="mt-1 text-sm font-medium text-danger">{error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="submit" className="flex min-h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover max-md:min-h-11"><Plus size={16} aria-hidden="true" />Add line</button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:min-h-11"><X size={16} aria-hidden="true" />Cancel</button>
      </div>
    </form>
  );
}

/** Remove a line: only when nothing is committed or paid on it, and only after an explicit confirm. Undo brings it back. */
function RemoveLine({ b, commit }: { b: BudgetItem; commit: Commit }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) keep.current?.focus(); }, [confirming]);
  if (b.committedPaise > 0 || b.payments.length > 0) return null;
  if (!confirming) return (
    <button type="button" onClick={() => setConfirming(true)} title="Remove this line"
      className="flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50 max-md:min-h-11 pointer-coarse:min-h-11">
      <Trash2 size={15} aria-hidden="true" />Remove<span className="sr-only"> {b.label}</span>
    </button>
  );
  return (
    <div role="group" aria-label={`Confirm removing ${b.label}`} className="flex basis-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
      <span>Remove “{b.label}” ({inr(b.plannedPaise)} planned)? You can undo it.</span>
      <button type="button" onClick={() => { const r = commit({ summary: `Remove "${b.label}"`, commands: [{ op: "remove_budget_item", budgetItemId: b.id }] }); if (!r.ok) setError(r.reason); }}
        className="flex min-h-9 items-center gap-1 rounded-lg bg-red-700 px-3 font-semibold text-white hover:bg-red-800 max-md:min-h-11">Remove line</button>
      <button ref={keep} type="button" onClick={() => setConfirming(false)} className="flex min-h-9 items-center rounded-lg border border-sand-500 bg-surface px-3 font-medium text-sand-800 hover:bg-sand-100 max-md:min-h-11">Keep it</button>
      {error && <p role="alert" className="basis-full font-medium">{error}</p>}
    </div>
  );
}

export default function BudgetCard({ plan, today, commit, highlight, onScan, busy }: { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onScan: (i: ScanInput) => void; busy: boolean }) {
  const hl = useHighlight(highlight);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const cats = [...new Set(plan.budgetItems.map(b => b.category))];
  const cuttable = categoryMaxCuttable(plan);
  const se = (id: string | null) => plan.subEvents.find(s => s.id === id)?.name;
  const uid = useId();
  // A highlighted line ("Show me", a deep link, an AI change) must be on screen: a new highlight opens the collapsed
  // categories that hold one (state adjusted while rendering, so the line is there before focus moves to it).
  const [seenHighlight, setSeenHighlight] = useState(highlight.key);
  if (seenHighlight !== highlight.key) {
    setSeenHighlight(highlight.key);
    const hit = new Set(plan.budgetItems.filter(b => highlight.ids.has(b.id) || b.payments.some(p => highlight.ids.has(p.id))).map(b => b.category));
    if (hit.size) setOpen(o => { const n = { ...o }; for (const c of hit) n[c] = true; return n; });
  }

  return (
    <Card id="budget" title="Smart Budget Ledger" icon={<Wallet size={18} className="text-emerald-700" />}
      subtitle="Planned envelopes by category. Lock a line so AI cuts skip it; scan a quote to update it.">
      <BudgetTotals plan={plan} commit={commit} />
      <ScanZone plan={plan} onScan={onScan} busy={busy} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><Legend /><AddLineForm plan={plan} commit={commit} onAdded={cat => setOpen(o => ({ ...o, [cat]: true }))} /></div>
      {/* The page is full width: from 1280px the vendor list sits beside the categories instead of under them. */}
      <div className={plan.vendors.length > 0 ? "xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6" : ""}>
      <div className="space-y-3">
        {cats.map(cat => {
          const items = plan.budgetItems.filter(b => b.category === cat);
          const planned = items.reduce((a, b) => a + b.plannedPaise, 0);
          const committed = items.reduce((a, b) => a + b.committedPaise, 0);
          const isOpen = open[cat] ?? (items.length > 1 || cat === "decor");
          const listId = `${uid}-${cat}`;
          const cut = cuttable[cat] ?? 0;
          return (
            <div key={cat} className="rounded-xl border border-line">
              <div className="flex flex-wrap items-center gap-x-2 pr-2 sm:pr-3">
                <h3 className="min-w-0 flex-1">
                  <button type="button" onClick={() => setOpen(o => ({ ...o, [cat]: !isOpen }))} aria-expanded={isOpen} aria-controls={isOpen ? listId : undefined}
                    className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2 text-left hover:bg-sand-50 sm:px-4">
                    <span aria-hidden="true" className="text-sand-600">{isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
                    <span className="text-base font-semibold text-ink">{CAT_LABEL[cat] ?? cat}</span>
                    <span className="text-sm text-ink-muted">{items.length} item{items.length > 1 ? "s" : ""}</span>
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm tabular-nums">
                      <span className="text-ink-muted">{inr(committed)} committed</span>
                      <Chip tone={cut > 0 ? "success" : "neutral"} icon={<Scissors size={13} />} title="Unlocked slack the AI can cut">{inr(cut)} cuttable</Chip>
                    </span>
                  </button>
                </h3>
                {/* The category total is the sum of its lines; editing it runs adjust_budget with the difference (a raise
                    lands on the largest unlocked line, a cut is spread over unlocked slack), exactly as an AI cut would. */}
                <InlineEdit label={`${CAT_LABEL[cat] ?? cat} planned total`} kind="rupees" value={String(planned / 100)} inputSize="w-36" className="py-1"
                  onSave={(paise: number) => paise === planned ? null : saveWith(commit, {
                    summary: `${CAT_LABEL[cat] ?? cat} planned total → ${inr(paise)}`,
                    commands: [{ op: "adjust_budget", category: cat as BudgetItem["category"], deltaPaise: paise - planned, reason: "Edited the category total" }] })}>
                  <span className="text-sm font-semibold tabular-nums text-ink">{inr(planned)} planned</span>
                </InlineEdit>
              </div>
              {isOpen && (
                <ul id={listId} className="divide-y divide-line-soft border-t border-line-soft">
                  {items.map(b => {
                    const overdue = b.payments.filter(p => !p.paidDate && p.dueDate < today);
                    const unpaid = b.payments.filter(p => !p.paidDate);
                    const slack = Math.max(0, b.plannedPaise - b.committedPaise);
                    return (
                      <li key={b.id} id={refAnchor(b.id)} className={`px-3 py-3.5 sm:px-4 ${hl(b.id)}`}>
                        <div className="max-w-5xl">
                          <div className="flex flex-wrap items-center gap-2">
                            <InlineEdit label={`name of budget line ${b.label}`} value={b.label}
                              onSave={(name: string) => saveWith(commit, { summary: `Rename "${b.label}"`, commands: [{ op: "rename_entity", kind: "budget_item", id: b.id, name }] })}>
                              <span className="text-base font-medium text-ink">{b.label}</span>
                            </InlineEdit>
                            <FigureTag kind={figureKind(b)} />
                            {se(b.subEventId) && <Chip tone="info" icon={<CalendarDays size={13} />}>{se(b.subEventId)}</Chip>}
                            {overdue.length > 0 && <Chip tone="danger" icon={<AlertTriangle size={13} />}>Deposit overdue</Chip>}
                            {b.quotedPaise !== null && b.quotedPaise > b.plannedPaise && <Chip tone="warning" icon={<TrendingUp size={13} />}><span className="tabular-nums">Quote {inr(b.quotedPaise)}</span> over envelope</Chip>}
                            {b.quoteRedFlags.length > 0 && <Chip tone="danger" icon={<FileWarning size={13} />} title={b.quoteRedFlags.join("\n")}>{b.quoteRedFlags.length} contract flag{b.quoteRedFlags.length > 1 ? "s" : ""}</Chip>}
                            <button type="button" aria-pressed={b.locked}
                              onClick={() => commit({ summary: `${b.locked ? "Unlock" : "Lock"} ${b.label}`, commands: [{ op: "set_item_lock", budgetItemId: b.id, locked: !b.locked }] })}
                              className={`ml-auto flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ring-1 ring-inset max-md:min-h-11 pointer-coarse:min-h-11 ${b.locked ? "bg-sand-800 text-white ring-sand-800 hover:bg-sand-700" : "bg-surface text-sand-800 ring-sand-500 hover:bg-sand-100"}`}
                              title={b.locked ? "Pinned: the AI can't cut this. Click to unlock." : "Pin this so cuts skip it"}>
                              {b.locked ? <><Lock size={15} aria-hidden="true" /> Locked</> : <><Unlock size={15} aria-hidden="true" /> Lock</>}<span className="sr-only"> {b.label}</span>
                            </button>
                            <RemoveLine b={b} commit={commit} />
                          </div>
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="min-w-0 flex-1 basis-40"><EnvelopeBar b={b} /></div>
                            <InlineEdit label={`planned amount for ${b.label}`} kind="rupees" value={String(b.plannedPaise / 100)} inputSize="w-36" className="shrink-0 justify-end"
                              onSave={(paise: number) => saveWith(commit, { summary: `${b.label}: planned ${inr(paise)}`,
                                commands: [{ op: "set_planned_amount", budgetItemId: b.id, plannedPaise: paise, expectedPaise: b.plannedPaise }] })}>
                              <span className="block text-right text-base font-semibold tabular-nums text-ink sm:w-28"><span className="sr-only">planned </span>{inr(b.plannedPaise)}</span>
                            </InlineEdit>
                          </div>
                          {/* The bar's numbers in words, so nothing depends on reading the segment colours. */}
                          <p className="mt-1.5 text-sm tabular-nums text-ink-muted">
                            {inr(b.committedPaise)} committed
                            {" · "}{b.locked ? <span className="inline-flex items-center gap-1"><Lock size={13} aria-hidden="true" />{inr(slack)} slack, locked</span> : <span className="font-medium text-emerald-800">{inr(slack)} cuttable</span>}
                            {b.committedPaise > b.plannedPaise && <>{" · "}<span className="font-semibold text-red-700">over plan by {inr(b.committedPaise - b.plannedPaise)}</span></>}
                            {b.quotedPaise !== null && <>{" · "}quoted {inr(b.quotedPaise)}</>}
                            {b.basis === "per_guest" && b.perGuestPaise !== null && <>{" · "}<span data-testid={`per-guest-${b.id}`}>per guest: {inr(b.perGuestPaise)} (rescales with the guest count)</span></>}
                          </p>
                          {(unpaid.length > 0 || b.payments.some(p => p.paidDate)) && (
                            <ul className="mt-2 space-y-1.5">
                              {unpaid.map(p => {
                                const late = p.dueDate < today;
                                return (
                                  <li key={p.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm tabular-nums ${late ? "font-medium text-red-700" : "text-sand-700"} ${hl(p.id)}`}>
                                    <span aria-hidden="true">{late ? <AlertTriangle size={15} /> : <CircleDollarSign size={15} />}</span>
                                    <span className="capitalize">{p.kind}</span> {inr(p.amountPaise)} {late ? "overdue since" : "due"} {longDate(p.dueDate)}
                                    <button type="button" onClick={() => commit({ summary: `Record ${p.kind} for ${b.label}`, commands: [{ op: "record_payment", budgetItemId: b.id, paymentId: p.id, paidDate: today }] })}
                                      className="flex min-h-9 items-center gap-1 rounded-lg bg-surface px-3 text-sm font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-600 hover:bg-emerald-50 max-md:min-h-11 pointer-coarse:min-h-11">
                                      <CheckCircle2 size={15} aria-hidden="true" /> Mark paid<span className="sr-only">: {p.kind} {inr(p.amountPaise)} for {b.label}</span>
                                    </button>
                                  </li>
                                );
                              })}
                              {b.payments.filter(p => p.paidDate).map(p => (
                                <li key={p.id} className={`flex items-center gap-1.5 text-sm tabular-nums text-emerald-800 ${hl(p.id)}`}><CheckCircle2 size={15} aria-hidden="true" /> <span className="capitalize">{p.kind}</span> {inr(p.amountPaise)} paid</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {plan.vendors.length > 0 && (
        <div className="mt-6 xl:mt-0">
          <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-ink"><Store size={17} aria-hidden="true" className="text-sand-600" /> Vendors</h3>
          <ul className="divide-y divide-line-soft rounded-xl border border-line">
            {plan.vendors.map(v => {
              const lines = plan.budgetItems.filter(b => b.vendorId === v.id).length;
              return (
                <li key={v.id} id={refAnchor(v.id)} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-4 ${hl(v.id)}`}>
                  <InlineEdit label={`vendor name ${v.name}`} value={v.name}
                    onSave={(name: string) => saveWith(commit, { summary: `Rename vendor "${v.name}"`, commands: [{ op: "rename_entity", kind: "vendor", id: v.id, name }] })}>
                    <span className="break-words text-sm font-medium text-ink">{v.name}</span>
                  </InlineEdit>
                  <span className="text-sm text-ink-muted sm:ml-auto">{CAT_LABEL[v.category] ?? v.category} · {lines} line{lines === 1 ? "" : "s"} · <span className="capitalize">{v.stage}</span></span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </div>
    </Card>
  );
}
