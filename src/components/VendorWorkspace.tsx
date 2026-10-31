"use client";
// v6: the vendor workspace. A checklist of the vendors this kind of event needs (needed → shortlisted → quoted → booked,
// or not needed), the vendors on each, "Questions to ask" (live Gemini or the curated Demo Mode bank), and a structured
// side-by-side quote comparison with a per-guest figure computed in code. Anything not from an actual quote is labelled
// Unverified; no price or availability is ever claimed. Every change goes through the reducer (booking and removing a
// vendor are previewed as approval cards first).
import { useId, useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronRight, CircleSlash, ListChecks, Loader2, Plus, RotateCcw, Scale, Store, Trash2, X } from "lucide-react";
import type { AgentState, BudgetCategory, Vendor, VendorStage } from "@/schema";
import type { BatchInput } from "@/commands";
import { checklistProgress, checklistRows, compareQuotes, SLOT_STATUS_LABEL, SLOT_STEPS, type ChecklistRow, type SlotStatus } from "@/vendors";
import { CATEGORY_LABEL } from "@/priorities";
import { refAnchor } from "@/routes";
import { usePlanner } from "./planner-context";
import ApprovalPreview from "./ApprovalPreview";
import { QuestionsCard } from "./ChatSidebar";
import { Card, Chip, FigureTag, inr, useHighlight, type Tone } from "./ui";

const STAGES: VendorStage[] = ["shortlisted", "contacted", "quoted", "negotiating", "booked", "dropped"];
const STAGE_LABEL: Record<VendorStage, string> = { shortlisted: "Shortlisted", contacted: "Contacted", quoted: "Quoted", negotiating: "Negotiating", booked: "Booked", dropped: "Dropped" };
const STATUS_TONE: Record<SlotStatus, Tone> = { not_needed: "neutral", needed: "warning", shortlisted: "info", quoted: "primary", booked: "success" };
const btn = "flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11";
const ghost = `${btn} border border-line-strong bg-surface text-sand-800 hover:bg-sand-100`;

function Steps({ status }: { status: SlotStatus }) {
  const at = SLOT_STEPS.indexOf(status);
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-1 text-xs">
      {SLOT_STEPS.map((s, i) => {
        const done = status !== "not_needed" && i <= at;
        return (
          <li key={s} aria-current={i === at ? "step" : undefined} className={`flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset ${done ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-sand-100 text-sand-700 ring-sand-300"}`}>
            {done && <Check size={11} aria-hidden="true" />}{SLOT_STATUS_LABEL[s]}<span className="sr-only">{done ? " (reached)" : " (not yet)"}</span>
          </li>
        );
      })}
    </ol>
  );
}

function AddVendorForm({ row, onDone }: { row: ChecklistRow; onDone: () => void }) {
  const { commit } = usePlanner();
  const id = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("Enter the vendor's name."); return; }
    const r = commit({ summary: `Add ${name.trim()} for ${row.slot.label.toLowerCase()}`, commands: [{ op: "add_vendor", name: name.trim(), category: row.slot.category, need: row.slot.key, ...(phone.trim() ? { phone: phone.trim() } : {}) }] });
    if (!r.ok) { setError(r.reason); return; }
    onDone();
  };
  const field = "mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink";
  return (
    <form noValidate onSubmit={submit} aria-label={`Add a vendor for ${row.slot.label}`} data-testid={`add-vendor-form-${row.slot.key}`} className="mt-2 grid gap-2 rounded-lg border border-line bg-surface-muted p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
      <div><label htmlFor={`${id}-n`} className="text-sm font-medium text-ink">Vendor name</label><input id={`${id}-n`} value={name} onChange={e => setName(e.target.value)} maxLength={120} className={field} /></div>
      <div><label htmlFor={`${id}-p`} className="text-sm font-medium text-ink">Phone (optional)</label><input id={`${id}-p`} value={phone} onChange={e => setPhone(e.target.value)} maxLength={30} inputMode="tel" className={field} /></div>
      <div className="flex gap-2">
        <button type="submit" className={`${btn} min-h-11 bg-primary font-semibold text-white hover:bg-primary-hover`}><Plus size={15} aria-hidden="true" />Add</button>
        <button type="button" onClick={onDone} className={`${ghost} min-h-11`}><X size={15} aria-hidden="true" />Cancel</button>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-danger sm:col-span-3">{error}</p>}
      <p className="text-sm text-ink-muted sm:col-span-3">Added as shortlisted and Unverified: no price or availability until you have their quote.</p>
    </form>
  );
}

function VendorLine({ v, plan }: { v: Vendor; plan: AgentState }) {
  const { commit, highlight } = usePlanner();
  const hl = useHighlight(highlight);
  const [pending, setPending] = useState<{ batch: BatchInput; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = v.quotes[v.quotes.length - 1];
  const committed = plan.budgetItems.filter(b => b.vendorId === v.id).reduce((a, b) => a + b.committedPaise, 0);
  const setStage = (stage: VendorStage) => {
    const batch: BatchInput = { summary: `${v.name}: ${STAGE_LABEL[stage].toLowerCase()}`, commands: [{ op: "set_vendor_stage", vendorId: v.id, stage }] };
    if (stage === "booked") { setPending({ batch, label: `Review: book ${v.name}` }); return; }
    const r = commit(batch);
    setError(r.ok ? null : r.reason);
  };
  return (
    <li id={refAnchor(v.id)} className={`rounded-lg border border-line-soft bg-surface px-3 py-2 ${hl(v.id)}`} data-testid={`vendor-${v.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-semibold text-ink">{v.name}</span>
        {committed > 0 ? <FigureTag kind="committed" /> : q ? <FigureTag kind="quoted" /> : <FigureTag kind="unverified" />}
        {q && <span className="text-sm tabular-nums text-ink">{inr(q.amountPaise)}{q.basis === "per_guest" ? " per guest" : q.basis === "per_hour" ? " per hour" : ""}</span>}
        <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <label className="sr-only" htmlFor={`stage-${v.id}`}>Stage for {v.name}</label>
          <select id={`stage-${v.id}`} value={v.stage} onChange={e => setStage(e.target.value as VendorStage)} data-testid={`vendor-stage-${v.id}`}
            className="h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink max-md:h-11">
            {STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          <button type="button" onClick={() => setPending({ batch: { summary: `Remove vendor ${v.name}`, commands: [{ op: "remove_vendor", vendorId: v.id }] }, label: `Review: remove ${v.name}` })}
            className={`${btn} text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50`}><Trash2 size={15} aria-hidden="true" />Remove<span className="sr-only"> {v.name}</span></button>
        </span>
      </div>
      {v.phone && <p className="mt-0.5 text-sm text-ink-muted">{v.phone}</p>}
      {error && <p role="alert" className="mt-1 text-sm font-medium text-danger">{error}</p>}
      {pending && <div className="mt-2"><ApprovalPreview plan={plan} batch={pending.batch} label={pending.label} testId="vendor-approval"
        onCancel={() => setPending(null)} onApprove={() => { const r = commit(pending.batch); if (r.ok) setPending(null); else setError(r.reason); }} /></div>}
    </li>
  );
}

/** Quotes side by side: amount, basis, guests covered, per-guest (computed in code), inclusions, extras and open questions. */
export function QuoteComparison({ row, plan }: { row: ChecklistRow; plan: AgentState }) {
  const qs = compareQuotes(plan, row.vendors);
  const cheapest = qs[0]?.perGuestPaise ?? null;
  const cell = "border-t border-line-soft px-3 py-2 align-top";
  const list = (xs: string[], empty = "Not stated") => xs.length ? <ul className="list-disc space-y-0.5 pl-4">{xs.map(x => <li key={x}>{x}</li>)}</ul> : <span className="text-ink-muted">{empty}</span>;
  return (
    <div className="mt-3 space-y-2" data-testid={`quote-compare-${row.slot.key}`}>
      {/* Below 640px: one card per quote, same facts, no sideways scrolling. */}
      <ul className="space-y-2 sm:hidden" aria-label={`Quotes for ${row.slot.label}, compared`}>
        {qs.map(q => (
          <li key={q.vendorId} className="rounded-lg border border-line bg-surface p-4 text-sm text-ink">
            <p className="flex flex-wrap items-center gap-2 font-semibold">{q.vendorName}<FigureTag kind="quoted" />
              {q.perGuestPaise === cheapest && qs.length > 1 && <Chip tone="success" icon={<Check size={12} />}>Lowest per guest</Chip>}</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 tabular-nums">
              <dt className="text-ink-muted">Quoted</dt><dd><span className="font-semibold">{inr(q.amountPaise)}</span> {q.basis === "per_guest" ? "per guest" : q.basis === "per_hour" ? "per hour" : "flat"}</dd>
              <dt className="text-ink-muted">Guests</dt><dd>{q.guests}{q.guestsAssumed && <span className="text-ink-muted"> (assumed)</span>}</dd>
              <dt className="text-ink-muted">Whole event</dt><dd>{q.totalPaise === null ? "Needs the hours" : inr(q.totalPaise)}</dd>
              <dt className="text-ink-muted">Per guest</dt><dd data-testid={`per-guest-m-${q.vendorId}`} className="font-semibold">{q.perGuestPaise === null ? "Can’t compare yet" : inr(q.perGuestPaise)}</dd>
            </dl>
            <p className="mt-2 font-medium">Included</p>{list(q.inclusions)}
            <p className="mt-2 font-medium">Not included</p>{list(q.exclusions)}
            <p className="mt-2 font-medium">Extra charges</p>
            {q.extras.length ? <ul className="space-y-0.5">{q.extras.map(x => <li key={x.label}>{x.label}: {x.amountPaise === null ? <span className="font-medium text-amber-800">amount not stated</span> : inr(x.amountPaise)}</li>)}</ul> : <span className="text-ink-muted">None listed</span>}
            <p className="mt-2 font-medium">Still to clarify</p>{list(q.openQuestions, "Nothing flagged")}
          </li>
        ))}
      </ul>
      <div role="region" aria-label={`Quote comparison for ${row.slot.label}`} tabIndex={0} className="scroll-thin hidden overflow-x-auto rounded-xl border border-line focus-visible:outline-offset-2 sm:block">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="sr-only">Quotes for {row.slot.label}, compared side by side</caption>
          <thead className="bg-surface-muted">
            <tr><th scope="col" className="px-3 py-2 font-medium text-ink-muted">Compared</th>
              {qs.map(q => <th key={q.vendorId} scope="col" className="px-3 py-2 font-semibold text-ink">{q.vendorName}<span className="mt-0.5 block font-normal"><FigureTag kind="quoted" /></span></th>)}</tr>
          </thead>
          <tbody className="tabular-nums text-ink">
            <tr><th scope="row" className={`${cell} font-medium`}>Quoted amount</th>{qs.map(q => <td key={q.vendorId} className={cell}><span className="font-semibold">{inr(q.amountPaise)}</span> {q.basis === "per_guest" ? "per guest" : q.basis === "per_hour" ? "per hour" : "flat"}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Guests covered</th>{qs.map(q => <td key={q.vendorId} className={cell}>{q.guests}{q.guestsAssumed && <span className="block text-ink-muted">assumed: your guest count</span>}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>For the whole event</th>{qs.map(q => <td key={q.vendorId} className={cell}>{q.totalPaise === null ? <span className="text-ink-muted">Needs the hours</span> : inr(q.totalPaise)}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Per guest (computed)</th>{qs.map(q => (
              <td key={q.vendorId} className={cell} data-testid={`per-guest-${q.vendorId}`}>{q.perGuestPaise === null ? <span className="text-ink-muted">Can’t compare yet</span>
                : <><span className="font-semibold">{inr(q.perGuestPaise)}</span>{q.perGuestPaise === cheapest && qs.length > 1 && <span className="ml-1.5 align-middle"><Chip tone="success" icon={<Check size={12} />}>Lowest per guest</Chip></span>}</>}</td>))}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>What’s included</th>{qs.map(q => <td key={q.vendorId} className={cell}>{list(q.inclusions)}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Not included</th>{qs.map(q => <td key={q.vendorId} className={cell}>{list(q.exclusions)}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Extra charges</th>{qs.map(q => (
              <td key={q.vendorId} className={cell}>{q.extras.length ? <ul className="space-y-0.5">{q.extras.map(x => <li key={x.label}>{x.label}: {x.amountPaise === null ? <span className="font-medium text-amber-800">amount not stated</span> : inr(x.amountPaise)}</li>)}</ul> : <span className="text-ink-muted">None listed</span>}</td>))}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Still to clarify</th>{qs.map(q => <td key={q.vendorId} className={cell}>{list(q.openQuestions, "Nothing flagged")}</td>)}</tr>
            <tr><th scope="row" className={`${cell} font-medium`}>Received</th>{qs.map(q => <td key={q.vendorId} className={cell}>{q.receivedOn}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="text-sm text-ink-muted">Per guest = the quote for the whole event ÷ guests covered, worked out in code. Extra charges are listed, not added. Quotes aren’t confirmed availability: check dates with each vendor before booking.</p>
    </div>
  );
}

function SlotRow({ row, plan }: { row: ChecklistRow; plan: AgentState }) {
  const { commit, requestVendorQuestions } = usePlanner();
  const [adding, setAdding] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [qs, setQs] = useState<{ label: string; questions: string[]; source: "gemini" | "demo"; warning?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(row.status !== "not_needed");
  const quoted = row.vendors.filter(v => v.quotes.length > 0).length;
  const off = row.status === "not_needed";
  const ask = async () => {
    setLoading(true); setError(null);
    const r = await requestVendorQuestions(row.slot.key);
    setLoading(false);
    if (r.ok) setQs({ label: r.label, questions: r.questions, source: r.mode === "gemini" ? "gemini" : "demo", warning: r.warning }); else setError(r.error);
  };
  const toggleNeed = () => { const r = commit({ summary: `${row.slot.label}: ${off ? "needed" : "not needed"}`, commands: [{ op: "set_vendor_need", need: row.slot.key, needed: off }] }); if (!r.ok) setError(r.reason); };
  const hid = `slot-${row.slot.key}-h`;
  return (
    <li data-testid={`vendor-slot-${row.slot.key}`} data-status={row.status} className={`rounded-xl border ${off ? "border-dashed border-line-strong bg-sand-50" : "border-line bg-surface"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <h3 id={hid} className="min-w-0 flex-1 basis-full sm:basis-48">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex min-h-10 w-full items-center gap-2 text-left">
            <span aria-hidden="true" className="shrink-0 text-sand-600">{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
            <span className="min-w-0">
              <span className={`text-base font-semibold ${off ? "text-ink-muted line-through" : "text-ink"}`}>{row.slot.label}</span>
              {row.slot.optional && <span className="ml-2 text-sm font-normal text-ink-muted">Optional</span>}
            </span>
          </button>
        </h3>
        <span data-testid={`slot-status-${row.slot.key}`}><Chip tone={STATUS_TONE[row.status]} icon={row.status === "booked" ? <Check size={12} /> : off ? <CircleSlash size={12} /> : <Store size={12} />}>{SLOT_STATUS_LABEL[row.status]}</Chip></span>
        <span className="text-sm tabular-nums text-ink-muted">{CATEGORY_LABEL[row.slot.category as BudgetCategory]}: {inr(row.plannedPaise)} set aside</span>
        <FigureTag kind="estimate" />
      </div>
      {open && (
        <div className="space-y-4 border-t border-line-soft px-4 pb-4 pt-4">
          {!off && <Steps status={row.status} />}
          <p className="text-sm text-ink"><span className="font-medium">What you need from them: </span>{row.slot.need}</p>
          {row.vendors.length > 0 ? <ul className="space-y-2">{row.vendors.map(v => <VendorLine key={v.id} v={v} plan={plan} />)}</ul>
            : !off && <p className="text-sm text-ink-muted">No vendor yet. Add one you’re considering; it stays Unverified until they send a quote.</p>}
          <div className="flex flex-wrap gap-2">
            {!off && <button type="button" onClick={() => setAdding(a => !a)} aria-expanded={adding} data-testid={`add-vendor-${row.slot.key}`} className={ghost}><Plus size={15} aria-hidden="true" />Add vendor<span className="sr-only"> for {row.slot.label}</span></button>}
            {!off && <button type="button" onClick={() => void ask()} disabled={loading} data-testid={`questions-${row.slot.key}`} className={ghost}>
              {loading ? <Loader2 size={15} aria-hidden="true" className="animate-spin" /> : <ListChecks size={15} aria-hidden="true" />}Questions to ask<span className="sr-only"> the {row.slot.label.toLowerCase()}</span></button>}
            {quoted >= 2 && <button type="button" onClick={() => setComparing(c => !c)} aria-expanded={comparing} data-testid={`compare-${row.slot.key}`} className={`${btn} bg-primary font-semibold text-white hover:bg-primary-hover`}><Scale size={15} aria-hidden="true" />{comparing ? "Hide comparison" : `Compare ${quoted} quotes`}</button>}
            <button type="button" onClick={toggleNeed} data-testid={`not-needed-${row.slot.key}`} className={ghost}>
              {off ? <><RotateCcw size={15} aria-hidden="true" />Needed after all</> : <><CircleSlash size={15} aria-hidden="true" />Not needed</>}<span className="sr-only"> ({row.slot.label})</span></button>
          </div>
          {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
          {adding && <AddVendorForm row={row} onDone={() => setAdding(false)} />}
          {qs && <div>{qs.warning && <p className="mb-1 text-sm text-amber-800">{qs.warning}</p>}<QuestionsCard need={qs.label} questions={qs.questions} source={qs.source} /></div>}
          {comparing && quoted >= 2 && <QuoteComparison row={row} plan={plan} />}
        </div>
      )}
    </li>
  );
}

export default function VendorWorkspace() {
  const { plan } = usePlanner();
  const rows = checklistRows(plan);
  const p = checklistProgress(rows);
  const unassigned = plan.vendors.filter(v => v.stage !== "dropped" && !rows.some(r => r.vendors.some(x => x.id === v.id)));
  return (
    <Card id="vendors" title="Vendor checklist" icon={<Store size={18} className="text-peacock-700" />}
      subtitle={<>What a {plan.event.eventType} like this usually needs. <span className="font-medium text-ink" data-testid="vendor-progress">{p.booked} of {p.total} booked</span>. Figures are labelled: Estimate (your plan), Quoted (a vendor’s quote), Committed (signed), Unverified (no quote yet).</>}>
      <ul className="space-y-3" data-testid="vendor-checklist">{rows.map(r => <SlotRow key={r.slot.key} row={r} plan={plan} />)}</ul>
      {unassigned.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-base font-semibold text-ink">Other vendors</h3>
          <ul className="space-y-2">{unassigned.map(v => <VendorLine key={v.id} v={v} plan={plan} />)}</ul>
        </div>
      )}
    </Card>
  );
}
