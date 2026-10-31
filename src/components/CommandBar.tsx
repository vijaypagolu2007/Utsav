"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertTriangle, ArchiveRestore, CalendarDays, Check, CheckCircle2, ChevronDown, EyeOff, FileSpreadsheet, History, LayoutTemplate, Link2, MoreHorizontal, PartyPopper, Plus, Printer, Redo2, RotateCcw, Ticket, Trash2, Undo2, Wrench } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Insight, PlanInsights } from "@/insights";
import type { Role } from "@/commands";
import type { TemplateId } from "@/config/event-templates";
import type { SwitcherEntry, SwitcherSections } from "@/my-events";
import { daysLeft, type TrashItem } from "@/trash";
import { Chip, IconButton, longDate, severityTone } from "./ui";
import { SeverityIcon } from "./Overview";
import ThemeToggle from "./ThemeToggle";

type Props = {
  plan: AgentState; today: string; setToday: (d: string) => void; insights: PlanInsights;
  activeTemplate: TemplateId;
  /** v8 Part 0b: the event menu's "My events" and "Samples" (my-events.ts switcherSections). */
  events: SwitcherSections;
  onSwitch: (t: TemplateId) => void; onReset: () => void;
  /** "Load sample events" in the event menu (signed in, samples not loaded yet); omitted otherwise. */
  onLoadSamples?: () => void;
  /** v8 Part 0c: Recently deleted, and the delete / restore / delete-forever actions of the event menu. */
  trash: TrashItem[];
  onDeleteEvent: (slot: TemplateId) => void;
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  /** "Hide samples" (per device): null when there is no event of the organizer's own, so samples can't be hidden. */
  hideSamples: boolean | null;
  onToggleHideSamples: () => void;
  /** v8 Part 0d: "Restore samples" in the event menu (some sample deleted or hidden); omitted otherwise. */
  onRestoreSamples?: () => void;
  /** v8 Part 0d: every event is deleted: the switcher reads "No events" and the plan tools are hidden. */
  empty?: boolean;
  role: Role; setRole: (r: Role) => void;
  history: string[]; historyIdx: number; goTo: (i: number) => void; showInsight: (i: Insight) => void;
  onExportCsv: () => void; onExportRunSheet: () => void; onShare: () => void; shared: boolean;
  /** The page tabs (768px and up, organizer only): a second header row, so they stay in reach while scrolling. */
  nav?: ReactNode;
  /** Open the setup form for a brand-new plan. */
  onNewPlan: () => void;
  /** The account control (Sign in, or the account menu with the cloud status), docked at the end of the header row. */
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
        <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-surface p-1.5 shadow-lg">
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


/**
 * v8 Part 0b: the event's title is the event menu (WAI-ARIA APG menu button). The button has aria-haspopup="menu" and
 * aria-expanded; Enter, Space or ArrowDown opens it on the current event, ArrowUp on the last item. Events are
 * menuitemradio (aria-checked marks the one on screen), grouped under "My events" and "Samples"; "New event" and
 * "Load sample events" are plain menuitems. ArrowUp/ArrowDown wrap, Home/End jump, Enter/Space choose, Escape or a
 * click outside closes, and focus returns to the button. Tab leaves the menu and closes it. It is not a heading: each
 * page owns its h1.
 *
 * v8 Part 0c: each of "My events" has its own "Delete <title>" menuitem right after it (ArrowRight / ArrowLeft move
 * between the two; ArrowUp / ArrowDown visit both), so the event stays a menuitemradio. "Hide samples" is a
 * menuitemcheckbox. "Recently deleted" lists deleted events with "Restore" and "Delete forever" menuitems.
 * v8 Part 0d: every sample row has its Delete too, and "Restore samples" brings deleted or hidden samples back.
 */
type SwitcherProps = {
  title: string; active: TemplateId; events: SwitcherSections; onSwitch: (t: TemplateId) => void; onNewPlan: () => void; onLoadSamples?: () => void;
  trash: TrashItem[]; onDeleteEvent: (slot: TemplateId) => void; onRestore: (id: string) => void; onDeleteForever: (id: string) => void;
  hideSamples: boolean | null; onToggleHideSamples: () => void; onRestoreSamples?: () => void;
};
function EventSwitcher({ title, active, events, onSwitch, onNewPlan, onLoadSamples, trash, onDeleteEvent, onRestore, onDeleteForever, hideSamples, onToggleHideSamples, onRestoreSamples }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const btnId = useId(), menuId = useId(), mineId = useId(), samplesId = useId(), trashId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, btn, wrap);

  /** The menu's items in DOM order, read when a key is pressed (never during render). */
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]') ?? []);
  const focusItem = (i: number | "current" | "last") => {
    const all = items(), n = all.length;
    if (!n) return;
    const at = i === "current" ? Math.max(0, all.findIndex(el => el.getAttribute("aria-checked") === "true")) : i === "last" ? n - 1 : ((i % n) + n) % n;
    all[at]?.focus();
  };
  /** When the menu opened: "N days left" in Recently deleted is counted from then (render stays pure). */
  const [now, setNow] = useState(0);
  const openAt = (i: number | "current" | "last") => { setNow(Date.now()); setOpen(true); requestAnimationFrame(() => focusItem(i)); };
  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openAt("current"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); openAt("last"); }
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const i = items().findIndex(el => el === document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem("last"); }
    // An event's own Delete sits right after it: ArrowRight goes to it, ArrowLeft comes back.
    else if (e.key === "ArrowRight" && document.activeElement?.getAttribute("role") === "menuitemradio" && document.activeElement.nextElementSibling?.hasAttribute("data-row-action")) {
      e.preventDefault(); (document.activeElement.nextElementSibling as HTMLElement).focus();
    } else if (e.key === "ArrowLeft" && document.activeElement?.hasAttribute("data-row-action")) {
      e.preventDefault(); (document.activeElement.previousElementSibling as HTMLElement | null)?.focus();
    }
  };
  const select = (f: () => void) => { setOpen(false); btn.current?.focus(); f(); };

  const row = "flex min-h-11 w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-sand-100 focus:bg-sand-100";
  const eventRow = (e: SwitcherEntry, sample: boolean) => {
    const key = `event-${e.slot}`;
    const radio = (
      <button key={key} type="button" role="menuitemradio" aria-checked={e.active} tabIndex={-1} data-testid={`event-option-${e.slot}`}
        onClick={() => select(() => onSwitch(e.slot))} className={`${row} min-w-0 flex-1 ${e.active ? "bg-primary-soft" : ""}`}>
        <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 text-primary">{e.active && <Check size={16} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-ink">
            {e.title}
            {sample && e.now && <span className="font-normal text-ink-muted"> (now: {e.now})</span>}
          </span>
          <span className="block text-xs text-ink-muted">{e.detail}{sample && e.edited ? " · edited" : ""}</span>
        </span>
      </button>
    );
    // v8 Part 0d: samples have their Delete too (Part 0c offered it only for the organizer's own events).
    return (
      <div key={key} className="flex items-stretch gap-1">
        {radio}
        <button type="button" role="menuitem" tabIndex={-1} data-row-action="" aria-label={`Delete ${e.title}`} title={`Delete ${e.title}`}
          data-testid={`event-delete-${e.slot}`} onClick={() => select(() => onDeleteEvent(e.slot))}
          className="grid min-h-11 w-11 shrink-0 place-items-center rounded-lg text-red-700 hover:bg-red-50 focus:bg-red-50">
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
    );
  };
  const heading = "px-3 pb-1 pt-2 text-xs font-semibold text-ink-muted";

  return (
    <div ref={wrap} className="relative min-w-0"
      onBlur={e => { if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={btn} id={btnId} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openAt("current"))} onKeyDown={onButtonKey} title={title}
        data-testid="event-switcher" data-active={active}
        className="-ml-1.5 flex min-h-9 max-w-full items-center gap-1 rounded-lg px-1.5 text-left hover:bg-sand-100 max-md:min-h-11 pointer-coarse:min-h-11">
        <span className="sr-only">Event: </span>
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold text-ink sm:text-base xl:line-clamp-1">{title}</span>
        <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-sand-600 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div data-testid="event-menu"
          className="absolute left-0 z-40 mt-2 max-h-[min(30rem,75dvh)] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1.5 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
          <div ref={menu} role="menu" id={menuId} aria-labelledby={btnId} onKeyDown={onMenuKey}>
            {events.mine.length > 0 && (
              <div role="group" aria-labelledby={mineId}>
                <div id={mineId} className={heading}>My events</div>
                {events.mine.map(e => eventRow(e, false))}
              </div>
            )}
            {!hideSamples && (events.samples.length > 0 || events.covered.length > 0) && (
              <div role="group" aria-labelledby={samplesId} className={events.mine.length ? "mt-1 border-t border-line pt-1" : ""}>
                <div id={samplesId} className={heading}>Samples</div>
                {events.samples.map(e => eventRow(e, true))}
                {events.covered.map(c => (
                  <div key={c.slot} className="px-3 py-1.5 pl-[2.375rem] text-xs text-ink-muted">{c.name}: hidden while your own {c.type} uses its place.</div>
                ))}
              </div>
            )}
            <div role="group" aria-label="Actions" className="mt-1 border-t border-line pt-1">
              <button type="button" role="menuitem" tabIndex={-1} data-testid="event-new" onClick={() => select(onNewPlan)}
                className={`${row} items-center text-sm font-medium text-ink`}>
                <Plus size={16} aria-hidden="true" className="shrink-0 text-brand-700" /> New event
              </button>
              {onLoadSamples && (
                <button type="button" role="menuitem" tabIndex={-1} data-testid="event-load-samples" onClick={() => select(onLoadSamples)}
                  className={`${row} items-center text-sm font-medium text-ink`}>
                  <LayoutTemplate size={16} aria-hidden="true" className="shrink-0 text-peacock-700" /> Load sample events
                </button>
              )}
              {hideSamples !== null && (
                <button type="button" role="menuitemcheckbox" aria-checked={hideSamples} tabIndex={-1} data-testid="event-hide-samples" onClick={() => select(onToggleHideSamples)}
                  className={`${row} items-center text-sm font-medium text-ink`}>
                  <span aria-hidden="true" className="grid h-4 w-4 shrink-0 place-items-center rounded border border-sand-600 text-primary">{hideSamples && <Check size={12} />}</span>
                  <EyeOff size={16} aria-hidden="true" className="shrink-0 text-sand-700" /> Hide samples
                </button>
              )}
              {onRestoreSamples && !onLoadSamples && (
                <button type="button" role="menuitem" tabIndex={-1} data-testid="event-restore-samples" onClick={() => select(onRestoreSamples)}
                  className={`${row} items-center text-sm font-medium text-ink`}>
                  <RotateCcw size={16} aria-hidden="true" className="shrink-0 text-peacock-700" /> Restore samples
                </button>
              )}
            </div>
            {trash.length > 0 && (
              <div role="group" aria-labelledby={trashId} className="mt-1 border-t border-line pt-1" data-testid="recently-deleted">
                <div id={trashId} className={heading}>Recently deleted</div>
                {trash.map((t, i) => (
                  <div key={t.id} className="px-3 py-1.5" data-testid={`trash-item-${i}`} data-trash-id={t.id}>
                    <p className="break-words text-sm font-medium text-ink">{t.title}</p>
                    <p className="text-xs text-ink-muted">{daysLeft(t, now)} day{daysLeft(t, now) === 1 ? "" : "s"} left to restore</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <button type="button" role="menuitem" tabIndex={-1} aria-label={`Restore ${t.title}`} data-testid={`trash-restore-${i}`} onClick={() => select(() => onRestore(t.id))}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 focus:bg-sand-100">
                        <ArchiveRestore size={15} aria-hidden="true" className="text-emerald-700" /> Restore
                      </button>
                      <button type="button" role="menuitem" tabIndex={-1} aria-label={`Delete forever: ${t.title}`} data-testid={`trash-forever-${i}`} onClick={() => select(() => onDeleteForever(t.id))}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50 focus:bg-red-50">
                        <Trash2 size={15} aria-hidden="true" /> Delete forever
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CommandBar({ plan, today, setToday, insights, activeTemplate, events, onSwitch, onReset, onLoadSamples, role, setRole,
  history, historyIdx, goTo, showInsight, onExportCsv, onExportRunSheet, onShare, shared, nav, onNewPlan, account,
  trash, onDeleteEvent, onRestore, onDeleteForever, hideSamples, onToggleHideSamples, onRestoreSamples, empty = false }: Props) {
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
  // A calm outlined badge: red outline with any critical flag, amber with warnings only, green when all clear.
  const flagTone = insights.counts.critical ? "border-red-600 text-red-700" : flagCount ? "border-amber-700 text-amber-800" : "border-emerald-600 text-emerald-800";

  const menuItems: MenuItem[] = [
    { id: "new", label: "New plan", icon: <Plus size={16} className="text-brand-700" />, onSelect: onNewPlan, title: "Set up a plan for your own event" },
    { id: "csv", label: "Export CSV", icon: <FileSpreadsheet size={16} className="text-emerald-700" />, onSelect: onExportCsv, title: "Budget ledger as CSV" },
    { id: "print", label: "Print Run-Sheet", icon: <Printer size={16} className="text-brand-700" />, onSelect: onExportRunSheet, title: "Print-ready day-of run sheet (Save as PDF from the print dialog)" },
    { id: "reset", label: "Reset", icon: <RotateCcw size={16} />, onSelect: onReset, title: "Restore the clean preset for this event type (clears its history)", danger: true },
  ];

  return (
    <header ref={headerRef} className="festive-rule relative z-30 border-b border-line bg-surface/95 backdrop-blur md:sticky md:top-0">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 py-3 px-4 sm:px-6 lg:px-8 xl:flex-nowrap">
        {/* Brand + the event's name. Not a heading: each page has its own h1 (on Overview, the event's name). */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 xl:max-w-[17rem] xl:flex-initial 2xl:max-w-[24rem]">
          <div aria-hidden="true" className="logo-tile grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm"><PartyPopper size={18} /></div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-xs font-medium text-ink-muted">Utsav Co-Pilot</p>
            {guest
              ? <p className="line-clamp-2 break-words text-sm font-semibold text-ink sm:text-base xl:line-clamp-1" title={plan.event.title}>{plan.event.title}</p>
              : <EventSwitcher title={empty ? "No events" : plan.event.title} active={activeTemplate} events={events} onSwitch={onSwitch} onNewPlan={onNewPlan} onLoadSamples={onLoadSamples}
                  trash={trash} onDeleteEvent={onDeleteEvent} onRestore={onRestore} onDeleteForever={onDeleteForever} hideSamples={hideSamples} onToggleHideSamples={onToggleHideSamples}
                  onRestoreSamples={onRestoreSamples} />}
          </div>
        </div>

        {/* Wraps (never overlaps) when the row runs out of room: wider system fonts or a classic Windows scrollbar at 1280px. */}
        {!empty && <div className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-2 xl:order-none xl:basis-auto xl:flex-1">
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
                  data-testid="red-flags" data-tone={insights.counts.critical ? "critical" : flagCount ? "warning" : "clear"}
                  className={`flex h-9 items-center gap-1.5 rounded-full border-2 bg-surface px-3 text-sm font-semibold tabular-nums hover:bg-sand-100 max-md:h-11 pointer-coarse:h-11 ${flagTone}`}>
                  {flagCount ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />} <span className="whitespace-nowrap">{flagCount}<span className="max-sm:sr-only xl:max-2xl:sr-only"> red flag{flagCount === 1 ? "" : "s"}</span></span>
                </button>
                {flagsOpen && (
                  <div ref={flagsBox} id={flagsId} className="absolute right-0 z-40 mt-2 max-h-[min(26rem,70dvh)] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
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
              <MoreMenu items={menuItems}>
                <div role="group" aria-label="Planning and history" className="space-y-3 px-2 py-1.5">
                  <div>
                    <label htmlFor={dateId} className="flex items-center gap-1.5 text-sm font-medium text-ink"><CalendarDays size={16} aria-hidden="true" /> Planning date</label>
                    <input id={dateId} type="date" value={today} aria-describedby={dateHintId} onChange={e => e.target.value && setToday(e.target.value)}
                      className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm tabular-nums text-ink" />
                    <p id={dateHintId} className="mt-1 text-sm tabular-nums text-ink-muted"><span className="font-medium text-ink">{longDate(today)}</span> · move it to time-travel the red flags</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink"><History size={16} aria-hidden="true" /> History <span className="font-normal tabular-nums text-ink-muted">step {historyIdx + 1} of {history.length}</span></p>
                    <input type="range" min={0} max={Math.max(0, history.length - 1)} value={historyIdx} onChange={e => goTo(Number(e.target.value))}
                      className="mt-1 h-8 w-full cursor-pointer accent-brand-700 disabled:cursor-not-allowed" disabled={history.length < 2} aria-label="History scrubber"
                      aria-valuetext={`Step ${historyIdx + 1} of ${history.length}: ${history[historyIdx] ?? ""}`} />
                    <p className="break-words text-sm text-ink-muted">{history[historyIdx]}</p>
                  </div>
                  <p className="border-t border-line pt-2 text-xs text-ink-muted">{plan.guests.length} guests on list · {plan.subEvents.length} sub-events · autosaved</p>
                </div>
              </MoreMenu>
            </div>
          )}
        </div>}

        {/* Top right: the theme toggle (both views, every width), then the account control (the Co-Pilot launcher floats at the bottom right instead). */}
        <div className="order-2 shrink-0 xl:order-none"><ThemeToggle /></div>
        <div className="order-2 shrink-0 xl:order-none" data-testid="header-account-slot">{account}</div>
      </div>
      {nav}
    </header>
  );
}
