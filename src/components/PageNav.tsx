"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CalendarRange, Contact, Ellipsis, LayoutDashboard, Lightbulb, ListChecks, PartyPopper, Store, Wallet, type LucideIcon } from "lucide-react";
import { PAGES, type PageId } from "@/routes";

const ICONS: Record<PageId, LucideIcon> = { overview: LayoutDashboard, budget: Wallet, vendors: Store, tasks: ListChecks, schedule: CalendarRange, event: PartyPopper, guests: Contact, ideas: Lightbulb };
/** Below 768px the bar keeps four pages; the rest sit in a "More" sheet so every target stays 44px+ and labels never truncate. */
export const BAR_PAGES: readonly PageId[] = ["overview", "budget", "tasks", "vendors"];
export const MORE_PAGES: readonly PageId[] = ["schedule", "event", "guests", "ideas"];

/**
 * The organizer's page navigation. One variant is rendered at a time (PlannerApp picks by width), so each link exists
 * once: tabs in the sticky header from 768px, a bottom tab bar below. Real route links (Next <Link>, client-side, so the
 * plan state, the drawer and the history carry over); aria-current="page" marks the open page.
 */
export function PageTabs({ current }: { current: PageId | null }) {
  return (
    <nav aria-label="Pages" className="border-t border-line-soft">
      <ul className="mx-auto flex max-w-7xl items-stretch gap-1 overflow-x-auto px-1 sm:px-3 lg:px-5">
        {PAGES.map(p => {
          const Icon = ICONS[p.id];
          const on = p.id === current;
          return (
            <li key={p.id} className="shrink-0">
              <Link href={p.href} aria-current={on ? "page" : undefined}
                className={`relative flex h-11 items-center gap-2 rounded-t-lg px-3 text-sm font-medium after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${on ? "text-brand-800 after:bg-[image:var(--tab-rule)]" : "text-sand-700 hover:bg-sand-100 hover:text-ink"}`}>
                <Icon size={17} aria-hidden="true" />{p.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Below 768px: fixed bottom tab bar (four pages + More), 44px+ targets, padded by the safe-area inset (PlannerApp reserves the same height). */
export function PageTabBar({ current }: { current: PageId | null }) {
  const [more, setMore] = useState(false);
  const sheetId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const inMore = current !== null && MORE_PAGES.includes(current);
  // Close on navigation (state adjusted while rendering), Escape (focus back to More) and a tap outside.
  const [seen, setSeen] = useState(current);
  if (seen !== current) { setSeen(current); setMore(false); }
  useEffect(() => {
    if (!more) return;
    sheetRef.current?.querySelector<HTMLElement>("a")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMore(false); btnRef.current?.focus(); } };
    const down = (e: PointerEvent) => { if (!sheetRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setMore(false); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", down); };
  }, [more]);
  const item = (id: PageId) => PAGES.find(p => p.id === id)!;
  const tab = "flex h-full min-h-11 flex-col items-center justify-center gap-0.5 px-0.5 text-xs font-medium";
  return (
    <nav aria-label="Pages" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      {more && (
        <div ref={sheetRef} id={sheetId} data-testid="more-sheet" className="absolute inset-x-3 bottom-[calc(100%+0.5rem)] mx-auto max-w-xl rounded-2xl border border-line bg-surface p-2 shadow-lg">
          <ul className="grid gap-1">
            {MORE_PAGES.map(id => {
              const p = item(id), Icon = ICONS[id], on = id === current;
              return (
                <li key={id}>
                  <Link href={p.href} aria-current={on ? "page" : undefined} onClick={() => setMore(false)}
                    className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-base font-medium ${on ? "bg-brand-50 text-brand-800" : "text-ink hover:bg-sand-100"}`}>
                    <Icon size={18} aria-hidden="true" />{p.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ul className="mx-auto grid h-[var(--tabbar-h)] max-w-xl grid-cols-5">
        {BAR_PAGES.map(id => {
          const p = item(id), Icon = ICONS[id], on = id === current;
          return (
            <li key={id} className="min-w-0">
              <Link href={p.href} aria-current={on ? "page" : undefined} className={`${tab} ${on ? "text-brand-800" : "text-sand-700 hover:text-ink"}`}>
                <span aria-hidden="true" className={`grid h-7 w-11 place-items-center rounded-full ${on ? "bg-brand-100" : ""}`}><Icon size={18} /></span>
                <span className="max-w-full truncate">{p.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0">
          <button ref={btnRef} type="button" aria-expanded={more} aria-controls={more ? sheetId : undefined} onClick={() => setMore(m => !m)} data-testid="more-button"
            aria-label={inMore ? `${item(current!).label}, more pages` : "More pages"}
            className={`${tab} w-full ${inMore || more ? "text-brand-800" : "text-sand-700 hover:text-ink"}`}>
            <span aria-hidden="true" className={`grid h-7 w-11 place-items-center rounded-full ${inMore ? "bg-brand-100" : ""}`}><Ellipsis size={18} /></span>
            <span className="max-w-full truncate">{inMore ? item(current!).label : "More"}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
