"use client";
// v6 on /budget: what matters most (priorities and experience level), "Over budget? Fix by my priorities", and a what-if
// panel. Every figure here is computed by code (priorities.ts) and every change is an approval card through the reducer.
import { useId, useMemo, useState } from "react";
import { ArrowUp, Check, FlaskConical, Scale, ShieldCheck, Wand2 } from "lucide-react";
import { BUDGET_CATEGORIES, type AgentState, type BudgetCategory, type ExperienceLevel, type PriorityTier } from "@/schema";
import { plannedTotal } from "@/commands";
import { buildPriorityFix, CATEGORY_LABEL, categoryTotals, isDefaultPriorities, LEVEL_HINT, LEVEL_LABEL, tierOf, whatIf } from "@/priorities";
import ApprovalPreview from "./ApprovalPreview";
import type { Commit } from "./PlannerApp";
import { Card, Chip, inr, parseInline } from "./ui";

const TIERS: { id: PriorityTier; label: string }[] = [{ id: "protect", label: "Protect" }, { id: "flexible", label: "Flexible" }, { id: "cut_first", label: "Cut first" }];
const LEVELS: ExperienceLevel[] = ["simple", "balanced", "premium"];
const pill = "flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700 max-md:min-h-11";
const pillOn = "border-brand-700 bg-brand-50 text-brand-800";
const pillOff = "border-line-strong bg-surface text-sand-800 hover:bg-sand-100";
const btn = "flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11";

/** Categories in the plan, in the schema's order, so the editor lists what the organiser actually has. */
const planCategories = (plan: AgentState): BudgetCategory[] => BUDGET_CATEGORIES.filter(c => plan.budgetItems.some(b => b.category === c));

/** The ranked must-protect / flexible / cut-first editor plus the experience level. Saving is set_priorities (Tier 0). */
export function PrioritiesPanel({ plan, commit }: { plan: AgentState; commit: Commit }) {
  const uid = useId();
  const cats = planCategories(plan);
  const saved = plan.priorities;
  type Draft = { tiers: Record<string, PriorityTier>; level: ExperienceLevel; rank: BudgetCategory[] };
  const [draft, setDraft] = useState<Draft | null>(null);
  const tiers = draft?.tiers ?? Object.fromEntries(cats.map(c => [c, tierOf(saved, c)]));
  const level = draft?.level ?? saved.level;
  const rank = draft?.rank ?? saved.protect;
  const [error, setError] = useState<string | null>(null);
  const ordered = (t: PriorityTier, keep: BudgetCategory[]) => [...keep.filter(c => tiers[c] === t && cats.includes(c)), ...cats.filter(c => tiers[c] === t && !keep.includes(c))];
  // Must-protect is ranked: the order the organiser set (Move up), new ones last.
  const protect = ordered("protect", rank), cutFirst = ordered("cut_first", saved.cutFirst);
  const dirty = draft !== null && (protect.join() !== saved.protect.filter(c => cats.includes(c)).join() || cutFirst.join() !== saved.cutFirst.filter(c => cats.includes(c)).join() || level !== saved.level);
  const set = (c: BudgetCategory, t: PriorityTier) => setDraft({ tiers: { ...tiers, [c]: t }, level, rank: t === "protect" ? [...protect.filter(x => x !== c), c] : protect.filter(x => x !== c) });
  const raise = (c: BudgetCategory) => {
    const i = protect.indexOf(c);
    if (i <= 0) return;
    const next = [...protect];
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    setDraft({ tiers, level, rank: next });
  };
  const save = () => {
    const r = commit({ summary: "Update priorities", commands: [{ op: "set_priorities", protect, cutFirst, level }] });
    if (r.ok) { setDraft(null); setError(null); } else setError(r.reason);
  };
  return (
    <Card id="priorities" title="What matters most" icon={<ShieldCheck size={18} className="text-brand-700" />}
      subtitle="Protect what you care about; cut-first categories give way first when money is short. Overrun fixes and AI cuts follow this, computed in code.">
      <div data-testid="priorities-panel" className="space-y-4">
        <fieldset>
          <legend className="text-sm font-medium text-ink">Experience level</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {LEVELS.map(l => (
              <label key={l} className={`${pill} ${level === l ? pillOn : pillOff}`}>
                <input type="radio" name={`${uid}-level`} value={l} checked={level === l} onChange={() => setDraft({ tiers, level: l, rank: protect })} className="sr-only" data-testid={`priority-level-${l}`} />
                {level === l && <Check size={14} aria-hidden="true" className="mr-1" />}{LEVEL_LABEL[l]}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-sm text-ink-muted">{LEVEL_HINT[level]}</p>
        </fieldset>
        <ul className="divide-y divide-line-soft rounded-xl border border-line">
          {cats.map(c => (
            <li key={c} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
                <span className="flex flex-wrap items-center gap-2">
                  <span id={`${uid}-${c}-l`} className="text-sm font-medium text-ink">{CATEGORY_LABEL[c]}</span>
                  {tiers[c] === "protect" && protect.length > 1 && <span className="text-sm text-ink-muted" data-testid={`protect-rank-${c}`}>#{protect.indexOf(c) + 1} to protect</span>}
                  {tiers[c] === "protect" && protect.indexOf(c) > 0 && (
                    <button type="button" onClick={() => raise(c)} data-testid={`raise-${c}`} className="flex min-h-8 items-center gap-1 rounded-md px-1.5 text-sm text-sand-800 ring-1 ring-inset ring-sand-400 hover:bg-sand-100 max-md:min-h-11">
                      <ArrowUp size={13} aria-hidden="true" />Move up<span className="sr-only"> {CATEGORY_LABEL[c]} in what to protect</span>
                    </button>
                  )}
                </span>
                <div role="radiogroup" aria-labelledby={`${uid}-${c}-l`} className="flex flex-wrap gap-1.5">
                  {TIERS.map(t => (
                    <label key={t.id} className={`${pill} ${tiers[c] === t.id ? pillOn : pillOff}`}>
                      <input type="radio" name={`${uid}-${c}`} value={t.id} checked={tiers[c] === t.id} onChange={() => set(c, t.id)} className="sr-only" data-testid={`priority-${c}-${t.id}`} />
                      {tiers[c] === t.id && <Check size={13} aria-hidden="true" className="mr-1" />}{t.label}<span className="sr-only"> {CATEGORY_LABEL[c]}</span>
                    </label>
                  ))}
                </div>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={!dirty} data-testid="save-priorities" className={`${btn} bg-primary text-white hover:bg-primary-hover`}>Save priorities</button>
          {dirty && <button type="button" onClick={() => setDraft(null)} className={`${btn} border border-line-strong bg-surface font-medium text-sand-800 hover:bg-sand-100`}>Discard</button>}
          <span className="text-sm text-ink-muted">{isDefaultPriorities(saved) ? "No priorities saved yet: every category is flexible." : `Protecting ${saved.protect.map(c => CATEGORY_LABEL[c]).join(", ") || "nothing"}; cutting ${saved.cutFirst.map(c => CATEGORY_LABEL[c]).join(", ") || "nothing"} first.`}</span>
        </div>
      </div>
    </Card>
  );
}

/** "Over budget? Fix by my priorities": an approval card listing each trade-off, computed by code. */
export function FixByPriorities({ plan, commit }: { plan: AgentState; commit: Commit }) {
  const [open, setOpen] = useState(false);
  const over = plannedTotal(plan) - plan.event.totalBudgetPaise;
  const fix = useMemo(() => (open ? buildPriorityFix(plan) : null), [open, plan]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={over <= 0} aria-expanded={open} data-testid="fix-by-priorities" onClick={() => setOpen(o => !o)}
          className={`${btn} ${over > 0 ? "bg-maroon-800 text-white hover:bg-maroon-900" : "border border-line-strong bg-surface text-sand-800"}`}>
          <Wand2 size={16} aria-hidden="true" />Over budget? Fix by my priorities
        </button>
        <span className="text-sm text-ink-muted">{over > 0 ? `Planned is ${inr(over)} over: cuts come from cut-first, then flexible categories; protected ones stay.` : "Within your total: nothing to fix."}</span>
      </div>
      {open && fix && (fix.ok
        ? <ApprovalPreview plan={plan} batch={fix.batch} explain={fix.explain} label="Review: fix the overrun by your priorities" testId="priority-fix-preview"
            onCancel={() => setOpen(false)} onApprove={() => { const r = commit(fix.batch); if (r.ok) setOpen(false); }} />
        : <p role="status" className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">{fix.reason}</p>)}
    </div>
  );
}

/** What-if: change one category or the guest count and see headroom and every category move, then commit as an approval card. */
export function WhatIfPanel({ plan, commit }: { plan: AgentState; commit: Commit }) {
  const uid = useId();
  const cats = planCategories(plan);
  const [mode, setMode] = useState<"category" | "guests">("category");
  const [cat, setCat] = useState<BudgetCategory>(cats.includes("photo_video") ? "photo_video" : cats[0] ?? "decor");
  const [amount, setAmount] = useState("");
  const [guests, setGuests] = useState("");
  const [balance, setBalance] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const field = "mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink tabular-nums";
  const totals = categoryTotals(plan);
  const parsed = mode === "category" ? (amount.trim() ? parseInline("rupees", amount) : null) : (guests.trim() ? (/^\d{1,6}$/.test(guests.trim()) ? { ok: true as const, value: Number(guests.trim()) } : { ok: false as const, error: "Enter a whole number of guests." }) : null);
  const preview = useMemo(() => {
    if (!parsed || !parsed.ok) return null;
    return whatIf(plan, mode === "category" ? { category: cat, plannedPaise: parsed.value as number } : { guestCount: parsed.value as number }, { balance });
  }, [plan, mode, cat, parsed?.ok, parsed && parsed.ok ? parsed.value : null, balance]); // eslint-disable-line react-hooks/exhaustive-deps -- parsed is derived from amount/guests
  const changed = preview?.ok ? cats.filter(c => (preview.after[c] ?? 0) !== (preview.before[c] ?? 0)) : [];
  const reset = () => setReviewing(false);
  return (
    <Card id="what-if" title="What if…?" icon={<FlaskConical size={18} className="text-peacock-700" />}
      subtitle="Try a change and see what it does to the rest before you commit. Nothing changes until you approve.">
      <div data-testid="what-if" className="space-y-3">
        <div role="radiogroup" aria-label="What to change" className="flex flex-wrap gap-2">
          {([["category", "Spend more or less on a category"], ["guests", "Change the guest count"]] as const).map(([m, l]) => (
            <label key={m} className={`${pill} ${mode === m ? pillOn : pillOff}`}>
              <input type="radio" name={`${uid}-mode`} checked={mode === m} onChange={() => { setMode(m); reset(); }} className="sr-only" data-testid={`whatif-mode-${m}`} />{l}
            </label>
          ))}
        </div>
        {mode === "category" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor={`${uid}-cat`} className="text-sm font-medium text-ink">Category</label>
              <select id={`${uid}-cat`} value={cat} onChange={e => { setCat(e.target.value as BudgetCategory); reset(); }} className={field} data-testid="whatif-category">
                {cats.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]} (now {inr(totals[c] ?? 0)})</option>)}
              </select></div>
            <div><label htmlFor={`${uid}-amt`} className="text-sm font-medium text-ink">New planned total (₹)</label>
              <input id={`${uid}-amt`} value={amount} onChange={e => { setAmount(e.target.value); reset(); }} inputMode="numeric" placeholder={String((totals[cat] ?? 0) / 100)} className={field} data-testid="whatif-amount" /></div>
          </div>
        ) : (
          <div className="max-w-xs"><label htmlFor={`${uid}-g`} className="text-sm font-medium text-ink">Guests (now {plan.event.guestCount})</label>
            <input id={`${uid}-g`} value={guests} onChange={e => { setGuests(e.target.value); reset(); }} inputMode="numeric" placeholder={String(plan.event.guestCount)} className={field} data-testid="whatif-guests" /></div>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={balance} onChange={e => { setBalance(e.target.checked); reset(); }} className="h-6 w-6 shrink-0 accent-brand-700" data-testid="whatif-balance" />
          Keep within my total (take any overrun from other categories by my priorities)
        </label>
        {parsed && !parsed.ok && <p role="alert" className="text-sm font-medium text-danger">{parsed.error}</p>}
        <div aria-live="polite" data-testid="whatif-result">
          {preview && !preview.ok && <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">{preview.reason}</p>}
          {preview?.ok && (
            <div className="space-y-2">
              <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm tabular-nums">
                <div><dt className="text-ink-muted">Not yet planned now</dt><dd className="font-semibold text-ink">{preview.headroomBefore < 0 ? `${inr(-preview.headroomBefore)} over` : inr(preview.headroomBefore)}</dd></div>
                <div><dt className="text-ink-muted">After this change</dt><dd data-testid="whatif-headroom" className={`font-semibold ${preview.headroomAfter < 0 ? "text-red-700" : "text-ink"}`}>{preview.headroomAfter < 0 ? `${inr(-preview.headroomAfter)} over` : inr(preview.headroomAfter)}</dd></div>
              </dl>
              <table className="w-full text-left text-sm tabular-nums">
                <caption className="sr-only">Category totals before and after</caption>
                <thead><tr className="text-ink-muted"><th scope="col" className="py-1 font-medium">Category</th><th scope="col" className="hidden py-1 pl-2 text-right font-medium sm:table-cell">Now</th><th scope="col" className="py-1 pl-2 text-right font-medium">After</th><th scope="col" className="py-1 pl-2 text-right font-medium">Change</th></tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {changed.map(c => {
                    const d = (preview.after[c] ?? 0) - (preview.before[c] ?? 0);
                    return (
                      <tr key={c} data-testid={`whatif-row-${c}`}>
                        <th scope="row" className="py-1.5 font-medium text-ink">{CATEGORY_LABEL[c]}{plan.priorities.protect.includes(c) && <span className="ml-1.5 align-middle"><Chip tone="success" icon={<ShieldCheck size={12} />}>Protected</Chip></span>}
                          <span className="block font-normal text-ink-muted sm:hidden">was {inr(preview.before[c] ?? 0)}</span></th>
                        <td className="hidden whitespace-nowrap py-1.5 pl-2 text-right text-ink-muted sm:table-cell">{inr(preview.before[c] ?? 0)}</td>
                        <td className="whitespace-nowrap py-1.5 pl-2 text-right font-semibold text-ink">{inr(preview.after[c] ?? 0)}</td>
                        <td className={`whitespace-nowrap py-1.5 pl-2 text-right font-semibold ${d < 0 ? "text-red-700" : "text-emerald-800"}`}>{d < 0 ? "−" : "+"}{inr(Math.abs(d))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!reviewing && <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">{preview.explain.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {!reviewing ? (
                <button type="button" onClick={() => setReviewing(true)} data-testid="whatif-review" className={`${btn} bg-primary text-white hover:bg-primary-hover`}><Scale size={16} aria-hidden="true" />Review as an approval card</button>
              ) : (
                <ApprovalPreview plan={plan} batch={preview.batch} explain={preview.explain} label="Review: what-if change" testId="whatif-preview"
                  onCancel={() => setReviewing(false)} onApprove={() => { const r = commit(preview.batch); if (r.ok) { setReviewing(false); setAmount(""); setGuests(""); } }} />
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
