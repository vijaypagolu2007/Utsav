"use client";
// The organizer's pages. Each is a thin view over the shared plan state (usePlanner) that the (planner) layout keeps
// across client navigation; the route files in src/app/(planner) only add the page's <title>.
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarRange, Clock, Lightbulb, ListChecks, MapPin, PartyPopper, RotateCcw, Trash2, Users, Wallet } from "lucide-react";
import { IDEA_KIND_LABEL } from "@/ideas";
import IdeasBoard from "./IdeasBoard";
import GuestsPageBody from "./GuestsPage";
import SetupWizard from "./SetupWizard";
import type { AgentState } from "@/schema";
import { daysBetween, taskDueDate } from "@/commands";
import { kpisFor } from "@/config/kpis";
import { kpiContext } from "@/kpis";
import { pageById, type PageId } from "@/routes";
import { usePlanner } from "./planner-context";
import type { Commit } from "./PlannerApp";
import { AttentionPanel, KpiStrip } from "./Overview";
import BudgetCard from "./BudgetCard";
import { PrioritiesPanel, WhatIfPanel } from "./BudgetPlanning";
import VendorWorkspace from "./VendorWorkspace";
import TaskCard from "./TaskCard";
import TimelineCard from "./TimelineCard";
import ArchetypeCard from "./ArchetypeCard";
import { accentTone, Card, Chip, hhmm, inr, InlineEdit, prettyDate, relDays, saveWith } from "./ui";

/**
 * Every page opens with its one h1. Client navigation moves focus here (tabIndex -1 makes it focusable from script
 * without adding a Tab stop), so it is also where a screen reader picks up on the new page.
 */
function PageHeading({ page, heading, headingId, children }: { page: PageId; heading?: ReactNode; headingId?: string; children?: ReactNode }) {
  const p = pageById(page);
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        {heading !== undefined && <p className="text-sm font-semibold uppercase tracking-wider text-ink-muted">{p.label}</p>}
        <h1 id={headingId} tabIndex={-1} data-testid="page-heading" className="break-words text-2xl font-semibold leading-tight text-ink focus-visible:outline-offset-4 sm:text-3xl">{heading ?? p.title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">{p.description}</p>
      </div>
      {children}
    </div>
  );
}

const Frame = ({ children }: { children: ReactNode }) => <div className="mx-auto max-w-[100rem] space-y-5">{children}</div>;

// ---------------------------------------------------------------- Overview
/**
 * Event name and, for weddings, the couple: edited in place (Tier 0 renames through the reducer). At the right end,
 * "Delete event" (red, outlined) for every event; v8 Part 0d: samples too, with a secondary "Reset sample" before it.
 */
function EventDetails({ plan, commit, actions }: { plan: AgentState; commit: Commit; actions: { isSample: boolean; requestDelete: () => void; resetSample: () => void } }) {
  const ext = plan.event.ext;
  const couple = ext.type === "wedding" ? ext.partners : null;
  const setPartner = (i: 0 | 1) => (name: string) => couple && saveWith(commit, { summary: "Update the couple's names",
    commands: [{ op: "set_partner_names", partners: i === 0 ? [name, couple[1]] : [couple[0], name] }] });
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm sm:px-4" data-testid="event-details">
      <InlineEdit label="event name" value={plan.event.title} inputSize="w-72"
        onSave={(title: string) => saveWith(commit, { summary: "Rename the event", commands: [{ op: "rename_event", title }] })}>
        <span className="text-ink-muted">Event name: <span className="font-medium text-ink">{plan.event.title}</span></span>
      </InlineEdit>
      {couple && (
        <span className="flex flex-wrap items-center gap-x-1 text-ink-muted">Couple:
          <InlineEdit label="first partner's name" value={couple[0]} inputSize="w-40" onSave={setPartner(0)}><span className="font-medium text-ink">{couple[0] || "(not set)"}</span></InlineEdit>
          <span aria-hidden="true">&amp;</span><span className="sr-only">and</span>
          <InlineEdit label="second partner's name" value={couple[1]} inputSize="w-40" onSave={setPartner(1)}><span className="font-medium text-ink">{couple[1] || "(not set)"}</span></InlineEdit>
        </span>
      )}
      <span className="ml-auto flex flex-wrap justify-end gap-2 py-0.5">
        {actions.isSample && (
          <button type="button" onClick={actions.resetSample} data-testid="overview-reset-sample" title="Restore this sample as shipped (clears its history)"
            className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:min-h-11 pointer-coarse:min-h-11">
            <RotateCcw size={15} aria-hidden="true" /> Reset sample
          </button>
        )}
        <button type="button" onClick={actions.requestDelete} data-testid="overview-delete-event" aria-haspopup="dialog"
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-600 bg-surface px-3 text-sm font-semibold text-red-700 hover:bg-red-50 max-md:min-h-11 pointer-coarse:min-h-11">
          <Trash2 size={15} aria-hidden="true" /> Delete event
        </button>
      </span>
    </div>
  );
}

/** A compact card that summarises one page and links to it ("View budget"). */
function SummaryCard({ page, icon, children }: { page: PageId; icon: ReactNode; children: ReactNode }) {
  const p = pageById(page);
  return (
    <Card title={p.label} icon={icon} className="flex flex-col" bodyClassName="flex flex-1 flex-col gap-3">
      <div className="flex-1 space-y-2 text-sm" data-testid={`summary-${page}`}>{children}</div>
      <Link href={p.href} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 text-sm font-semibold text-brand-800 underline-offset-2 hover:bg-brand-50 hover:underline md:min-h-9">
        View {p.label.toLowerCase()}<ArrowRight size={15} aria-hidden="true" />
      </Link>
    </Card>
  );
}

/** A plain progress bar for a summary card. Decorative: the sentence next to it carries the numbers. */
function Bar({ value, max, tone = "bg-emerald-700" }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-sand-100 ring-1 ring-inset ring-sand-400">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function BudgetSummary({ plan, today }: { plan: AgentState; today: string }) {
  const c = kpiContext(plan, today);
  const overdue = plan.budgetItems.flatMap(b => b.payments).filter(p => !p.paidDate && p.dueDate < today).length;
  const over = c.planned > c.total;
  return (
    <SummaryCard page="budget" icon={<Wallet size={18} className="text-emerald-700" />}>
      <p className="tabular-nums"><span className="text-base font-semibold text-ink">{inr(c.committed)}</span> <span className="text-ink-muted">committed of {inr(c.planned)} planned</span></p>
      <Bar value={c.committed} max={c.planned} />
      <p className="tabular-nums text-ink-muted">
        Planned is <span className={over ? "font-semibold text-red-700" : "font-medium text-ink"}>{inr(c.planned)}</span> of the {inr(c.total)} budget{over ? " (over)" : ""}
        {overdue > 0 && <> · <span className="font-semibold text-red-700">{overdue} deposit{overdue > 1 ? "s" : ""} overdue</span></>}
      </p>
    </SummaryCard>
  );
}

function TasksSummary({ plan, today }: { plan: AgentState; today: string }) {
  const open = plan.tasks.filter(t => t.status !== "done").map(t => ({ t, due: taskDueDate(plan, t) })).sort((a, b) => a.due.localeCompare(b.due));
  const next = open.slice(0, 3);
  return (
    <SummaryCard page="tasks" icon={<ListChecks size={18} className="text-peacock-700" />}>
      <p className="tabular-nums text-ink-muted">{open.length} open of {plan.tasks.length} task{plan.tasks.length === 1 ? "" : "s"}. Next up:</p>
      {next.length === 0 ? <p className="text-ink">Nothing left to do.</p> : (
        <ul className="divide-y divide-line-soft">
          {next.map(({ t, due }) => {
            const late = daysBetween(today, due) < 0;
            return (
              <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                <span className="min-w-0 break-words font-medium text-ink">{t.title}</span>
                <span className={`shrink-0 tabular-nums ${late ? "font-semibold text-red-700" : "text-ink-muted"}`}>{prettyDate(due)} · {relDays(today, due)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </SummaryCard>
  );
}

function ScheduleSummary({ plan, today }: { plan: AgentState; today: string }) {
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const next = subs.find(s => s.date >= today);
  const pub = subs.filter(s => s.visibility === "public").length;
  return (
    <SummaryCard page="schedule" icon={<CalendarRange size={18} className="text-brand-700" />}>
      {next ? (
        <div>
          <p className="text-ink-muted">Next sub-event</p>
          <p className="text-base font-semibold text-ink">{next.name}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-muted">
            <span className="flex items-center gap-1 tabular-nums"><Clock size={14} aria-hidden="true" />{prettyDate(next.date)} · {hhmm(next.startMin)} · {relDays(today, next.date)}</span>
            {next.venue && <span className="flex items-center gap-1"><MapPin size={14} aria-hidden="true" />{next.venue}</span>}
          </p>
        </div>
      ) : <p className="text-ink">{subs.length ? "Every sub-event has taken place." : "No sub-events yet."}</p>}
      <p className="tabular-nums text-ink-muted">{subs.length} sub-event{subs.length === 1 ? "" : "s"} · {pub} on the public guest link</p>
    </SummaryCard>
  );
}

function EventSummary({ plan, today }: { plan: AgentState; today: string }) {
  const c = kpiContext(plan, today);
  const answered = c.invited - c.pending;
  const ext = plan.event.ext;
  return (
    <SummaryCard page="event" icon={<PartyPopper size={18} className="text-maroon-700" />}>
      {c.invited > 0 && c.main ? (
        <>
          <p className="tabular-nums"><span className="text-base font-semibold text-ink">{answered} of {c.invited}</span> <span className="text-ink-muted">guests have answered for {c.main.name} ({c.yes} yes)</span></p>
          <Bar value={answered} max={c.invited} tone="bg-brand-700" />
        </>
      ) : <p className="flex items-center gap-1.5 text-ink-muted"><Users size={15} aria-hidden="true" />No RSVPs to track yet ({plan.guests.length} on the guest list).</p>}
      {ext.type === "birthday" && <p className="tabular-nums text-ink-muted">Wishlist: {ext.wishlist.filter(w => w.claimedByGuestId).length} of {ext.wishlist.length} gifts claimed</p>}
      {ext.type === "wedding" && ext.wishlist.length > 0 && <p className="tabular-nums text-ink-muted">Gift registry: {ext.wishlist.filter(w => w.claimedByGuestId).length} of {ext.wishlist.length} gifts claimed</p>}
      {ext.type === "community" && (
        <p className="tabular-nums text-ink-muted">
          Permits: {ext.permits.filter(p => p.status === "approved").length} of {ext.permits.length} approved · Sponsors: {ext.sponsors.filter(s => s.status === "committed" || s.status === "paid").length} of {ext.sponsors.length} committed
        </p>
      )}
    </SummaryCard>
  );
}

function IdeasSummary({ plan }: { plan: AgentState }) {
  const active = plan.ideas.filter(i => i.status !== "dismissed");
  const adopted = plan.ideas.filter(i => i.adoptedTaskId || i.adoptedBudgetItemId).length;
  const saved = active.filter(i => i.status === "saved").length;
  const top = [...active].reverse().filter(i => !(i.adoptedTaskId || i.adoptedBudgetItemId)).slice(0, 2);
  return (
    <SummaryCard page="ideas" icon={<Lightbulb size={18} className="text-marigold-700" />}>
      {active.length === 0 ? <p className="text-ink-muted">No ideas yet. Get personalised themes, decor, menus, return gifts and more, sized to your budget.</p> : (
        <>
          <p className="tabular-nums text-ink-muted"><span className="text-base font-semibold text-ink">{active.length}</span> on the board · {saved} saved · {adopted} in your plan</p>
          {top.length > 0 && (
            <ul className="divide-y divide-line-soft">
              {top.map(i => <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"><span className="min-w-0 break-words font-medium text-ink">{i.title}</span><span className="shrink-0 text-ink-muted">{IDEA_KIND_LABEL[i.kind]}</span></li>)}
            </ul>
          )}
        </>
      )}
    </SummaryCard>
  );
}

export function OverviewPage() {
  const { plan, today, insights, template, commit, showInsight, eventActions } = usePlanner();
  return (
    <Frame>
      <section id="overview" aria-labelledby="overview-h" data-event-type={plan.event.eventType} className="festive-hero -mx-3 -mt-4 space-y-3 px-3 py-4 sm:mx-0 sm:mt-0 sm:rounded-2xl sm:p-5">
        <PageHeading page="overview" heading={plan.event.title} headingId="overview-h">
          <Chip tone={accentTone(template.accent)} icon={<MapPin size={13} />} className="capitalize">{plan.event.eventType} · {plan.event.city}</Chip>
        </PageHeading>
        <EventDetails plan={plan} commit={commit} actions={eventActions} />
        <KpiStrip kpis={kpisFor("organizer", plan.event.eventType)} ctx={kpiContext(plan, today)} />
      </section>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <AttentionPanel plan={plan} insights={insights} onShow={showInsight} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
          <BudgetSummary plan={plan} today={today} />
          <TasksSummary plan={plan} today={today} />
          <ScheduleSummary plan={plan} today={today} />
          <EventSummary plan={plan} today={today} />
          <IdeasSummary plan={plan} />
        </div>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- the section pages
export function BudgetPage() {
  const { plan, today, commit, highlight, scan, busy } = usePlanner();
  return (
    <Frame>
      <PageHeading page="budget" />
      <BudgetCard plan={plan} today={today} commit={commit} highlight={highlight} onScan={scan} busy={busy} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 xl:items-start">
        <PrioritiesPanel plan={plan} commit={commit} />
        <WhatIfPanel plan={plan} commit={commit} />
      </div>
    </Frame>
  );
}

export function VendorsPage() {
  return <Frame><PageHeading page="vendors" /><VendorWorkspace /></Frame>;
}

export function TasksPage() {
  const { plan, today, commit, highlight } = usePlanner();
  return <Frame><PageHeading page="tasks" /><TaskCard plan={plan} today={today} commit={commit} highlight={highlight} /></Frame>;
}

export function SchedulePage() {
  const { plan, commit, highlight } = usePlanner();
  return <Frame><PageHeading page="schedule" /><TimelineCard plan={plan} commit={commit} highlight={highlight} /></Frame>;
}

export function EventPage() {
  const { plan, today, commit, highlight, template, ask } = usePlanner();
  return <Frame><PageHeading page="event" /><ArchetypeCard template={template} plan={plan} today={today} commit={commit} highlight={highlight} onAsk={ask} /></Frame>;
}

/** v8 Part 1: households, imports, private invite links, the group join link and the RSVP change log. */
export function GuestsPage() {
  return <Frame><PageHeading page="guests" /><section id="guests" aria-label="Guest list" tabIndex={-1} className="focus-visible:outline-offset-4"><GuestsPageBody /></section></Frame>;
}

export function IdeasPage() {
  return <Frame><PageHeading page="ideas" /><IdeasBoard /></Frame>;
}

/** "New plan": the same setup form as the first-run welcome, inside the planner shell. */
export function SetupPage() {
  const { createPlan, eventActions } = usePlanner();
  const router = useRouter();
  return (
    <Frame>
      {/* v8 Part 0d: every event (samples too) was deleted: say so, and offer the samples back next to a new event. */}
      {eventActions.noEvents && (
        <div role="note" data-testid="no-events" className="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5">
          <p className="text-lg font-semibold text-ink">You have no events right now</p>
          <p className="mt-1 text-sm text-ink-muted">Start a new event below, bring back the three samples, or restore a deleted event from <span className="font-medium text-ink">Recently deleted</span> in the event menu (kept for 30 days).</p>
          <button type="button" onClick={eventActions.restoreSamples} data-testid="setup-restore-samples"
            className="mt-3 flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold text-sand-800 hover:bg-sand-100">
            <RotateCcw size={16} aria-hidden="true" className="text-peacock-700" /> Restore samples
          </button>
        </div>
      )}
      <SetupWizard onCreate={createPlan} onCancel={eventActions.noEvents ? undefined : () => router.push("/")} cancelLabel="Cancel" onDone={() => router.push("/")} />
    </Frame>
  );
}
