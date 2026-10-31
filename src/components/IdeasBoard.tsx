"use client";
// The organiser's idea board: personalised idea cards (Live AI or the curated Demo Mode bank), filtered by kind, with
// Save, Dismiss and Add to plan. Saving and dismissing are direct Tier 0 edits; Add to plan previews adopt_idea as an
// approval card first. Guests never reach this page (Guest View replaces it with the guest microsite).
import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bookmark, BookmarkCheck, CheckCircle2, Cpu, EyeOff, Lightbulb, Loader2, Plus, RotateCcw, Sparkles, Tag, Wand2, WifiOff } from "lucide-react";
import type { AgentState, Idea, IdeaKind } from "@/schema";
import { applyBatch, plannedTotal, type BatchInput } from "@/commands";
import { categoryHeadroom, IDEA_KIND_LABEL, IDEA_KINDS, REFINE_LABEL, type RefineMode } from "@/ideas";
import { cutCommands, explainCut, planPriorityCut } from "@/priorities";
import { refAnchor } from "@/routes";
import { usePlanner } from "./planner-context";
import ApprovalPreview from "./ApprovalPreview";
import { Card, Chip, Empty, FigureTag, inr, saveWith, useHighlight, type Tone } from "./ui";

const CAT_LABEL: Record<string, string> = {
  venue: "Venue", catering: "Catering", decor: "Decor", photo_video: "Photo & video", music: "Music", attire: "Attire", beauty: "Beauty",
  stationery: "Stationery", gifts: "Gifts", logistics: "Logistics", permits: "Permits", entertainment: "Entertainment", misc: "Misc",
};
const KIND_TONE: Record<IdeaKind, Tone> = { theme: "secondary", decor: "primary", menu: "gold", activity: "info", return_gift: "success", invite_text: "neutral", music: "secondary", photo: "info" };
const QUICK = ["eco-friendly", "under ₹50k", "Telangana style", "for kids", "traditional"];
const btn = "flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium max-md:min-h-11 pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50";

const range = (i: Idea) => i.estLowPaise === null ? null : i.estHighPaise !== null && i.estHighPaise !== i.estLowPaise ? `${inr(i.estLowPaise)} – ${inr(i.estHighPaise)}` : inr(i.estLowPaise);

/**
 * v6: what adopting an idea does to the budget, computed by code: the adopt batch, a warning when it puts a category or
 * the total over, and the "add it and fix by my priorities" batch (the idea's own category is kept).
 */
export function adoptPlan(plan: AgentState, idea: Idea, headroom: Record<string, number>) {
  const adopt: BatchInput = { summary: `Add "${idea.title}" to the plan`, commands: [{ op: "adopt_idea", ideaId: idea.id }] };
  const r = applyBatch(plan, adopt, { source: "ui" });
  if (!r.ok) return { adopt, warnings: [] as string[], fix: null };
  const over = plannedTotal(r.state) - r.state.event.totalBudgetPaise;
  const left = idea.category ? headroom[idea.category] ?? 0 : null;
  const warnings: string[] = [];
  if (idea.category && idea.estLowPaise && left !== null && idea.estLowPaise > left) warnings.push(`It costs more than the ${inr(left)} left in ${CAT_LABEL[idea.category]?.toLowerCase() ?? idea.category}.`);
  if (over > 0) warnings.push(`Adding it puts the plan ${inr(over)} over your ${inr(plan.event.totalBudgetPaise)} total.`);
  if (over <= 0) return { adopt, warnings, fix: null };
  const cut = planPriorityCut(r.state, over, idea.category ? { keep: [idea.category] } : {});
  if (!cut.cuts.length) return { adopt, warnings: [...warnings, "Nothing outside your must-protect categories can be cut to make room."], fix: null };
  return { adopt, warnings, fix: { batch: { summary: `Add "${idea.title}" and fix the ${inr(over)} overrun by your priorities`, commands: [...adopt.commands, ...cutCommands(cut)] } as BatchInput,
    explain: [`Adding "${idea.title}" puts the plan ${inr(over)} over. By your priorities:`, ...explainCut(cut, r.state)] } };
}

function IdeaCard({ idea, plan, headroom, onSave, onDismiss, onRestore, adopting, onAdopt, onCancelAdopt, onApproveAdopt, hl, onRefine, refining }: {
  idea: Idea; plan: AgentState; headroom: Record<string, number>; hl: string;
  onSave: () => void; onDismiss: () => void; onRestore: () => void;
  adopting: boolean; onAdopt: () => void; onCancelAdopt: () => void; onApproveAdopt: (b: BatchInput) => void;
  onRefine: (mode: RefineMode) => void; refining: boolean;
}) {
  const hid = `${useId()}-h`;
  const [fixing, setFixing] = useState(false);
  const adopted = !!(idea.adoptedTaskId || idea.adoptedBudgetItemId);
  const left = idea.category ? headroom[idea.category] ?? 0 : null;
  const over = !adopted && idea.estLowPaise !== null && idea.estLowPaise > 0 && left !== null && idea.estLowPaise > left;
  const plan6 = adopting && !adopted ? adoptPlan(plan, idea, headroom) : null;
  const batch: BatchInput = plan6?.adopt ?? { summary: `Add "${idea.title}" to the plan`, commands: [{ op: "adopt_idea", ideaId: idea.id }] };
  const dismissed = idea.status === "dismissed";
  const from = idea.refinedFrom ? plan.ideas.find(i => i.id === idea.refinedFrom) : null;
  return (
    <li id={refAnchor(idea.id)} className={`min-w-0 ${hl}`}>
      <article aria-labelledby={hid} data-testid={`idea-${idea.id}`} className={`flex h-full flex-col rounded-xl border bg-surface p-4 shadow-sm sm:p-5 ${dismissed ? "border-dashed border-line-strong" : "border-line"}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={KIND_TONE[idea.kind]} icon={<Tag size={12} />}>{IDEA_KIND_LABEL[idea.kind]}</Chip>
          {adopted ? <Chip tone="success" icon={<CheckCircle2 size={12} />}>In your plan</Chip>
            : idea.status === "saved" ? <Chip tone="primary" icon={<BookmarkCheck size={12} />}>Saved</Chip>
            : dismissed ? <Chip tone="neutral" icon={<EyeOff size={12} />}>Dismissed</Chip> : null}
          <span className="ml-auto text-xs font-medium text-ink-muted">{idea.source === "gemini" ? "Live AI" : "Demo"}</span>
        </div>
        {from && <p className="mt-1.5 text-sm text-ink-muted" data-testid={`refined-from-${idea.id}`}>Refined from “{from.title}”</p>}
        <h3 id={hid} className="mt-2 break-words text-base font-semibold text-ink">{idea.title}</h3>
        {idea.description && <p className="mt-1 break-words text-sm text-ink-muted">{idea.description}</p>}
        <p className="mt-2 text-sm tabular-nums text-ink">
          {range(idea) ? <><span className="font-semibold">{range(idea)}</span>{idea.category && <span className="text-ink-muted"> · {CAT_LABEL[idea.category] ?? idea.category}</span>} <span className="ml-1 align-middle"><FigureTag kind="estimate" /></span></> : <span className="text-ink-muted">No cost{idea.category ? ` · ${CAT_LABEL[idea.category] ?? idea.category}` : ""}</span>}
        </p>
        {over && left !== null && (
          <p className="mt-1.5"><Chip tone="warning" icon={<AlertTriangle size={12} />}><span className="tabular-nums">{left === 0 ? `No ${CAT_LABEL[idea.category!]?.toLowerCase()} money left yet` : `More than the ${inr(left)} left in ${CAT_LABEL[idea.category!]?.toLowerCase()}`}</span></Chip></p>
        )}
        {idea.tags.length > 0 && <p className="mt-2 flex flex-wrap gap-1">{idea.tags.slice(0, 5).map(t => <span key={t} className="rounded-full bg-sand-100 px-2 py-0.5 text-xs text-sand-700">{t}</span>)}</p>}
        <div className="mt-auto pt-3">
          {adopted ? (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              {idea.adoptedTaskId && plan.tasks.some(t => t.id === idea.adoptedTaskId) && <Link href={`/tasks#${refAnchor(idea.adoptedTaskId)}`} className="inline-flex min-h-9 items-center gap-1 font-semibold text-brand-800 underline underline-offset-2">View task<ArrowRight size={14} aria-hidden="true" /></Link>}
              {idea.adoptedBudgetItemId && plan.budgetItems.some(b => b.id === idea.adoptedBudgetItemId) && <Link href={`/budget#${refAnchor(idea.adoptedBudgetItemId)}`} className="inline-flex min-h-9 items-center gap-1 font-semibold text-brand-800 underline underline-offset-2">View budget line<ArrowRight size={14} aria-hidden="true" /></Link>}
            </p>
          ) : dismissed ? (
            <button type="button" onClick={onRestore} className={`${btn} border border-line-strong bg-surface text-sand-800 hover:bg-sand-100`}><RotateCcw size={15} aria-hidden="true" />Restore<span className="sr-only"> {idea.title}</span></button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={onSave} disabled={idea.status === "saved"} aria-pressed={idea.status === "saved"} className={`${btn} border border-line-strong bg-surface text-sand-800 hover:bg-sand-100`}>
                {idea.status === "saved" ? <BookmarkCheck size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />}{idea.status === "saved" ? "Saved" : "Save"}<span className="sr-only"> {idea.title}</span>
              </button>
              <button type="button" onClick={onDismiss} className={`${btn} border border-line-strong bg-surface text-sand-800 hover:bg-sand-100`}><EyeOff size={15} aria-hidden="true" />Dismiss<span className="sr-only"> {idea.title}</span></button>
              <button type="button" onClick={() => { setFixing(false); onAdopt(); }} aria-expanded={adopting} className={`${btn} bg-primary font-semibold text-white hover:bg-primary-hover`}><Plus size={15} aria-hidden="true" />Add to plan<span className="sr-only"> {idea.title}</span></button>
            </div>
          )}
          {!adopted && !dismissed && (
            <div role="group" aria-label={`Refine ${idea.title}`} className="mt-2 flex flex-wrap items-center gap-1" data-testid={`refine-${idea.id}`}>
              <Wand2 size={14} aria-hidden="true" className="mr-0.5 text-sand-600" />
              {(Object.keys(REFINE_LABEL) as RefineMode[]).map(m => {
                return (
                  <button key={m} type="button" disabled={refining} onClick={() => onRefine(m)} data-testid={`refine-${m}-${idea.id}`}
                    className="flex min-h-8 items-center rounded-full border border-line-strong bg-surface px-2 text-xs font-medium text-sand-800 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11">
                    {REFINE_LABEL[m]}<span className="sr-only"> for {idea.title}</span>
                  </button>
                );
              })}
            </div>
          )}
          {adopting && !adopted && (
            <div className="mt-3">
              <ApprovalPreview key={fixing ? "fix" : "adopt"} plan={plan} batch={fixing && plan6?.fix ? plan6.fix.batch : batch} explain={fixing ? plan6?.fix?.explain : undefined}
                label={`Review: add ${idea.title} to the plan`} onApprove={() => onApproveAdopt(fixing && plan6?.fix ? plan6.fix.batch : batch)} onCancel={onCancelAdopt}>
                {plan6 && plan6.warnings.length > 0 && (
                  <div data-testid="adopt-warning" className="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={15} aria-hidden="true" />Over budget</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">{plan6.warnings.map(w => <li key={w}>{w}</li>)}</ul>
                    {plan6.fix && (
                      <button type="button" aria-pressed={fixing} onClick={() => setFixing(f => !f)} data-testid="adopt-fix-by-priorities"
                        className="mt-2 flex min-h-10 items-center gap-1.5 rounded-lg bg-maroon-800 px-3 text-sm font-semibold text-white hover:bg-maroon-900 max-md:min-h-11">
                        <Wand2 size={15} aria-hidden="true" />{fixing ? "Just add it (stay over budget)" : "Add it and fix by my priorities"}
                      </button>
                    )}
                  </div>
                )}
              </ApprovalPreview>
            </div>
          )}
        </div>
      </article>
    </li>
  );
}

export default function IdeasBoard() {
  const { plan, commit, highlight, requestIdeas, ideasBusy, aiMode, forceOffline, flash } = usePlanner();
  const hl = useHighlight(highlight);
  const [kind, setKind] = useState<IdeaKind | "all">("all");
  const [showDismissed, setShowDismissed] = useState(false);
  const [focus, setFocus] = useState("");
  const [adopting, setAdopting] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);
  const focusId = useId();
  const head = categoryHeadroom(plan);
  const visible = plan.ideas.filter(i => (showDismissed || i.status !== "dismissed") && (kind === "all" || i.kind === kind));
  const active = plan.ideas.filter(i => i.status !== "dismissed");
  const dismissedCount = plan.ideas.length - active.length;
  const latest = plan.ideas.at(-1);
  const source = latest?.source ?? (aiMode === "gemini" ? "gemini" : null);

  const get = async (e?: FormEvent) => {
    e?.preventDefault();
    setResult(null);
    const r = await requestIdeas(focus.trim(), kind === "all" ? undefined : kind);
    if (!r.ok) setResult({ text: r.error, tone: "error" });
    else setResult({ text: `${r.added ? `${r.added} new idea${r.added === 1 ? "" : "s"} added` : "No new ideas this time; try another focus"} · ${r.mode === "gemini" ? "Live AI" : "Demo Mode"}${r.warning ? `. ${r.warning}` : ""}`, tone: r.warning ? "warn" : "ok" });
  };
  const run = (b: BatchInput) => saveWith(commit, b);
  const refine = async (idea: Idea, mode: RefineMode) => {
    setResult(null);
    const r = await requestIdeas("", undefined, { mode, ideaId: idea.id });
    if (!r.ok) setResult({ text: r.error, tone: "error" });
    else setResult({ text: `${REFINE_LABEL[mode]} for “${idea.title}”: ${r.added ? `${r.added} new idea${r.added === 1 ? "" : "s"} added at the top` : "nothing new this time"} · ${r.mode === "gemini" ? "Live AI" : "Demo Mode"}${r.warning ? `. ${r.warning}` : ""}`, tone: r.warning ? "warn" : "ok" });
  };

  return (
    <div className="space-y-6">
      <Card id="ideas" title="Get personalised ideas" icon={<Sparkles size={18} className="text-brand-700" />}
        subtitle={<>Ideas use your event type, city, traditions, guest count, diets, note and what’s left in each budget category. {source ? <span className="inline-flex items-center gap-1 font-medium text-ink">{source === "gemini" ? <Cpu size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}Source: {source === "gemini" ? "Live AI (Gemini)" : "Demo Mode (curated bank)"}</span> : forceOffline ? "Demo Mode is on." : null}</>}>
        <form onSubmit={get} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor={focusId} className="block text-sm font-medium text-ink">Focus (optional)</label>
            <input id={focusId} value={focus} onChange={e => setFocus(e.target.value)} maxLength={120} placeholder="e.g. eco-friendly, under ₹50k, Telangana style"
              className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink sm:text-sm" />
          </div>
          <button type="submit" disabled={ideasBusy} data-testid="get-ideas" className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60">
            {ideasBusy ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Lightbulb size={16} aria-hidden="true" />}{ideasBusy ? "Thinking…" : "Get more ideas"}
          </button>
        </form>
        <div role="group" aria-label="Quick focus" className="mt-2 flex flex-wrap gap-1.5">
          {QUICK.map(q => (
            <button key={q} type="button" onClick={() => setFocus(q)} aria-pressed={focus === q}
              className={`min-h-9 rounded-full border px-3 text-sm max-md:min-h-11 ${focus === q ? "border-brand-700 bg-brand-50 text-brand-800" : "border-line-strong bg-surface text-sand-800 hover:bg-sand-100"}`}>{q}</button>
          ))}
        </div>
        <p role="status" className="mt-2 min-h-5 text-sm">
          {ideasBusy ? <span className="text-ink-muted">Thinking up ideas for {plan.event.title}…</span>
            : result ? <span className={result.tone === "error" ? "font-medium text-danger" : result.tone === "warn" ? "text-amber-800" : "text-emerald-800"}>{result.text}</span> : null}
        </p>
      </Card>

      <section aria-labelledby="ideas-board-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ideas-board-h" className="text-lg font-semibold text-ink">Your idea board <span className="text-sm font-normal tabular-nums text-ink-muted">{active.length} idea{active.length === 1 ? "" : "s"}</span></h2>
          {dismissedCount > 0 && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)} className="h-6 w-6 shrink-0 accent-brand-700" />Show dismissed ({dismissedCount})
            </label>
          )}
        </div>
        <div role="group" aria-label="Filter by kind" className="scroll-thin flex gap-1.5 overflow-x-auto pb-1">
          {(["all", ...IDEA_KINDS] as const).map(k => {
            const n = k === "all" ? active.length : active.filter(i => i.kind === k).length;
            if (k !== "all" && n === 0 && kind !== k) return null;
            return (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                className={`flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-sm font-medium max-md:min-h-11 ${kind === k ? "border-brand-700 bg-brand-50 text-brand-800" : "border-line-strong bg-surface text-sand-800 hover:bg-sand-100"}`}>
                {k === "all" ? "All" : IDEA_KIND_LABEL[k]} <span className="tabular-nums text-ink-muted">{n}</span>
              </button>
            );
          })}
        </div>
        {ideasBusy && (
          <ul aria-hidden="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map(i => <li key={i} className="h-44 animate-pulse rounded-xl border border-line bg-surface-muted" />)}
          </ul>
        )}
        {visible.length === 0 && !ideasBusy ? (
          <Empty>
            {plan.ideas.length === 0 ? "No ideas yet. Press Get more ideas for themes, decor, menus, activities, return gifts, invite text, music and photo ideas made for this event."
              : "Nothing matches this filter."}
          </Empty>
        ) : (
          <ul data-testid="idea-list" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[...visible].reverse().map(i => (
              <IdeaCard key={i.id} idea={i} plan={plan} headroom={head} hl={hl(i.id)} refining={ideasBusy} onRefine={m => void refine(i, m)}
                onSave={() => run({ summary: `Save idea "${i.title}"`, commands: [{ op: "save_idea", ideaId: i.id }] })}
                onDismiss={() => run({ summary: `Dismiss idea "${i.title}"`, commands: [{ op: "dismiss_idea", ideaId: i.id }] })}
                onRestore={() => run({ summary: `Restore idea "${i.title}"`, commands: [{ op: "save_idea", ideaId: i.id }] })}
                adopting={adopting === i.id} onAdopt={() => setAdopting(a => (a === i.id ? null : i.id))} onCancelAdopt={() => setAdopting(null)}
                onApproveAdopt={b => {
                  const r = commit(b);
                  if (r.ok) { setAdopting(null); flash([i.id, ...(r.state.ideas.find(x => x.id === i.id)?.adoptedTaskId ? [r.state.ideas.find(x => x.id === i.id)!.adoptedTaskId!] : [])]); }
                }} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
