"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, FileSpreadsheet, History, Link2, MoreHorizontal, PartyPopper, Plus, Printer, Redo2, RotateCcw, Ticket, Undo2, Wrench } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Insight, PlanInsights } from "@/insights";
import type { Role } from "@/commands";
import { TEMPLATES, templateLabel, type TemplateId } from "@/config/event-templates";
import { Chip, IconButton, longDate, severityTone } from "./ui";
import { SeverityIcon } from "./Overview";
import ThemeSelect from "./ThemeSelect";

type Props = {
  plan: AgentState; today: string; setToday: (d: string) => void; insights: PlanInsights;
  activeTemplate: TemplateId; storedTitles: Record<string, string | null>; onSwitch: (t: TemplateId) => void; onReset: () => void;
  role: Role; setRole: (r: Role) => void;
  history: string[]; historyIdx: number; goTo: (i: number) => void; showInsight: (i: Insight) => void;
  onExportCsv: () => void; onExportRunSheet: () => void; onShare: () => void; shared: boolean;
  /** The single Co-Pilot launcher, docked at the end of the header row. */
  launcher: ReactNode;
  /** The page tabs (768px and up, organizer only): a second header row, so they stay in reach while scrolling. */
  nav?: ReactNode;
  /** Open the setup form for a brand-new plan. */
  onNewPlan: () => void;
  /** Optional Google sign-in and cloud status (renders nothing when sign-in isn't configured). */
  account?: ReactNode;
};

/** Close a popover on Escape (returning focus to `trigger`) or on a pointer press outside `trigger` and `box`. */
function useDismiss(open: boolean, setOpen: (v: boolean) => void, trigger: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !box.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, setOpen, trigger, box]);
}

type MenuItem = { id: string; label: string; icon: ReactNode; onSelect: () => void; title?: string; danger?: boolean };

/**
 * "More" overflow menu following the WAI-ARIA APG menu-button pattern: the button has aria-haspopup="menu" and
 * aria-expanded; Enter, Space or ArrowDown opens it on the first item, ArrowUp on the last; ArrowUp/ArrowDown wrap,
 * Home/End jump; Enter/Space activates an item, closes the menu and returns focus to the button; Escape closes and
 * returns focus. The menu is followed in the same popover by a small settings group (planning date, history
 * scrubber); form fields aren't allowed inside role="menu", so Tab moves from the menu into that group, and the
 * popover closes once focus leaves it.
 */
function MoreMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btnId = useId(), menuId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusItem = (i: number) => { const n = items.length; itemRefs.current[((i % n) + n) % n]?.focus(); };
  const openAt = (i: number) => { setOpen(true); requestAnimationFrame(() => focusItem(i)); };
  useDismiss(open, setOpen, btn, wrap);

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openAt(0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); openAt(items.length - 1); }
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const i = itemRefs.current.findIndex(el => el === document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(items.length - 1); }
  };
  const select = (it: MenuItem) => { setOpen(false); btn.current?.focus(); it.onSelect(); };

  return (
    <div ref={wrap} className="relative"
      onBlur={e => { if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={btn} id={btnId} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openAt(0))} onKeyDown={onButtonKey}
        className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:h-11 pointer-coarse:h-11">
        <MoreHorizontal size={16} aria-hidden="true" /> More
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-surface p-1.5 shadow-xl">
          <div role="menu" id={menuId} aria-labelledby={btnId} onKeyDown={onMenuKey}>
            {items.map((it, i) => (
              <button key={it.id} ref={el => { itemRefs.current[i] = el; }} type="button" role="menuitem" tabIndex={-1} title={it.title}
                onClick={() => select(it)}
                className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium hover:bg-sand-100 focus:bg-sand-100 ${it.danger ? "text-red-700" : "text-sand-800"}`}>
                <span aria-hidden="true">{it.icon}</span>{it.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 border-t border-line pt-1.5">{children}</div>
        </div>
      )}
    </div>
  );
}

export default function CommandBar({ plan, today, setToday, insights, activeTemplate, storedTitles, onSwitch, onReset, role, setRole,
  history, historyIdx, goTo, showInsight, onExportCsv, onExportRunSheet, onShare, shared, launcher, nav, onNewPlan, account }: Props) {
  const [flagsOpen, setFlagsOpen] = useState(false);
  const flagsId = useId(), dateHintId = useId(), dateId = useId();
  const flagsBtn = useRef<HTMLButtonElement>(null);
  const flagsBox = useRef<HTMLDivElement>(null);
  // Disclosure: Escape or a click elsewhere closes the red-flag list; Escape returns focus to its button.
  useDismiss(flagsOpen, setFlagsOpen, flagsBtn, flagsBox);
  // Publish the header's real height (one row at 1280px+, two below) so scroll-padding keeps focused and
  // anchored content clear of the sticky header (WCAG 2.4.11).
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--header-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const guest = role === "guest";
  const flagCount = insights.redFlags;

  const menuItems: MenuItem[] = [
    { id: "new", label: "New plan", icon: <Plus size={16} className="text-brand-700" />, onSelect: onNewPlan, title: "Set up a plan for your own event" },
    { id: "csv", label: "Export CSV", icon: <FileSpreadsheet size={16} className="text-emerald-700" />, onSelect: onExportCsv, title: "Budget ledger as CSV" },
    { id: "print", label: "Print Run-Sheet", icon: <Printer size={16} className="text-brand-700" />, onSelect: onExportRunSheet, title: "Print-ready day-of run sheet (Save as PDF from the print dialog)" },
    { id: "reset", label: "Reset", icon: <RotateCcw size={16} />, onSelect: onReset, title: "Restore the clean preset for this event type (clears its history)", danger: true },
  ];

  return (
    <header ref={headerRef} className="festive-rule relative z-30 border-b border-line bg-surface/95 backdrop-blur md:sticky md:top-0">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4 xl:flex-nowrap">
        {/* Brand + the event's name. Not a heading: each page has its own h1 (on Overview, the event's name). */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 xl:max-w-[19rem] xl:flex-initial 2xl:max-w-[24rem]">
          <div aria-hidden="true" className="logo-tile grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm"><PartyPopper size={18} /></div>
          <div className="min-w-0 leading-tight">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Utsav Co-Pilot</p>
            <p className="line-clamp-2 break-words text-sm font-semibold text-ink sm:text-base xl:line-clamp-1" title={plan.event.title}>{plan.event.title}</p>
          </div>
        </div>

        {/* Wraps (never overlaps) when the row runs out of room: wider system fonts or a classic Windows scrollbar at 1280px. */}
        <div className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-2 xl:order-none xl:basis-auto xl:flex-1">
          {!guest && (
            <label className="relative min-w-0 basis-full sm:basis-auto xl:min-w-[9rem] xl:max-w-[16rem] xl:flex-1">
              <span className="sr-only">Event</span>
              <select value={activeTemplate} onChange={e => onSwitch(e.target.value as TemplateId)}
                className="h-9 w-full max-w-full appearance-none truncate rounded-lg border border-line-strong bg-surface py-1.5 pl-3 pr-8 text-sm font-medium text-ink shadow-sm max-md:h-11 sm:w-[17rem] xl:w-full pointer-coarse:h-11">
                {TEMPLATES.map((t, i) => {
                  const now = storedTitles[t.id];
                  return <option key={t.id} value={t.id}>{i + 1}. {templateLabel(t)}{now && now !== t.seed.event.title ? ` (now: ${now})` : ""}</option>;
                })}
              </select>
              <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sand-600" />
            </label>
          )}
          {/* Two-state view switch: toggle buttons (aria-pressed) so Tab reaches both and Space/Enter selects. */}
          <div role="group" aria-label="View" className="flex shrink-0 rounded-lg bg-surface-muted p-0.5 text-sm font-medium ring-1 ring-inset ring-line">
            <button type="button" aria-pressed={!guest} onClick={() => setRole("organizer")}
              className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 max-md:h-10 pointer-coarse:h-10 ${!guest ? "bg-surface text-ink shadow-sm ring-1 ring-sand-400" : "text-sand-700 hover:text-ink"}`}><Wrench size={15} aria-hidden="true" /> Organizer</button>
            <button type="button" aria-pressed={guest} onClick={() => setRole("guest")}
              className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 max-md:h-10 pointer-coarse:h-10 ${guest ? "bg-surface text-brand-800 shadow-sm ring-1 ring-brand-400" : "text-sand-700 hover:text-ink"}`}><Ticket size={15} aria-hidden="true" /> Guest View</button>
          </div>

          {!guest && (
            <div className="flex flex-wrap items-center gap-2 xl:ml-auto xl:flex-nowrap">
              <div className="relative">
                <button type="button" ref={flagsBtn} onClick={() => setFlagsOpen(o => !o)} aria-expanded={flagsOpen} aria-controls={flagsOpen ? flagsId : undefined}
                  title={`${flagCount} red flag${flagCount === 1 ? "" : "s"}`}
                  className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold tabular-nums ring-1 ring-inset max-md:h-11 pointer-coarse:h-11 ${flagCount ? "bg-red-50 text-red-700 ring-red-300" : "bg-emerald-50 text-emerald-800 ring-emerald-300"}`}>
                  {flagCount ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />} <span className="whitespace-nowrap">{flagCount}<span className="max-sm:sr-only xl:max-2xl:sr-only"> red flag{flagCount === 1 ? "" : "s"}</span></span>
                </button>
                {flagsOpen && (
                  <div ref={flagsBox} id={flagsId} className="absolute right-0 z-40 mt-2 max-h-[min(26rem,70dvh)] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
                    {insights.insights.length === 0 && <p className="p-3 text-sm text-ink-muted">All clear.</p>}
                    <ul>
                      {insights.insights.map(i => (
                        <li key={i.id}>
                          <button type="button" onClick={() => { setFlagsOpen(false); showInsight(i); }} className="flex min-h-11 w-full items-start gap-2.5 rounded-lg p-2 text-left hover:bg-sand-100">
                            <Chip tone={severityTone(i.severity)} icon={<SeverityIcon severity={i.severity} />} className="mt-0.5 shrink-0">{i.severity}</Chip>
                            <span className="min-w-0"><span className="block text-sm font-medium text-ink">{i.title}</span><span className="block text-sm text-ink-muted">{i.detail}</span></span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <IconButton label="Undo" onClick={() => goTo(historyIdx - 1)} disabled={historyIdx === 0}><Undo2 size={16} /></IconButton>
              <IconButton label="Redo" onClick={() => goTo(historyIdx + 1)} disabled={historyIdx >= history.length - 1}><Redo2 size={16} /></IconButton>
              <button type="button" onClick={onShare} title="Shareable guest links (needs shared storage)" data-testid="open-guest-links" aria-haspopup="dialog"
                className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:h-11 pointer-coarse:h-11">
                <Link2 size={16} aria-hidden="true" className="text-peacock-700" /> <span className="whitespace-nowrap max-sm:sr-only">Guest links</span>
                {shared && <span className="rounded-full bg-emerald-50 px-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-300">live</span>}
              </button>
              {account}
              <MoreMenu items={menuItems}>
                <div role="group" aria-label="Planning and history" className="space-y-3 px-2 py-1.5">
                  <div>
                    <label htmlFor={dateId} className="flex items-center gap-1.5 text-sm font-medium text-ink"><CalendarDays size={16} aria-hidden="true" /> Planning date</label>
                    <input id={dateId} type="date" value={today} aria-describedby={dateHintId} onChange={e => e.target.value && setToday(e.target.value)}
                      className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm tabular-nums text-ink" />
                    <p id={dateHintId} className="mt-1 text-sm tabular-nums text-ink-muted"><span className="font-medium text-ink">{longDate(today)}</span> · move it to time-travel the red flags</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink"><History size={16} aria-hidden="true" /> History <span className="font-normal tabular-nums text-ink-muted">step {historyIdx + 1} of {history.length}</span></p>
                    <input type="range" min={0} max={Math.max(0, history.length - 1)} value={historyIdx} onChange={e => goTo(Number(e.target.value))}
                      className="mt-1 h-8 w-full cursor-pointer accent-brand-700 disabled:cursor-not-allowed" disabled={history.length < 2} aria-label="History scrubber"
                      aria-valuetext={`Step ${historyIdx + 1} of ${history.length}: ${history[historyIdx] ?? ""}`} />
                    <p className="break-words text-sm text-ink-muted">{history[historyIdx]}</p>
                  </div>
                  <ThemeSelect />
                  <p className="border-t border-line pt-2 text-xs text-ink-muted">{plan.guests.length} guests on list · {plan.subEvents.length} sub-events · autosaved</p>
                </div>
              </MoreMenu>
            </div>
          )}
        </div>

        <div className="order-2 shrink-0 xl:order-none">{launcher}</div>
      </div>
      {nav}
    </header>
  );
}
