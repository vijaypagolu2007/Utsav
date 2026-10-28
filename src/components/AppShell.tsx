"use client";
import { usePathname } from "next/navigation";
import { PartyPopper } from "lucide-react";
import { isSetupPath, pageForPath, SETUP_TITLE } from "@/routes";
import { PageTabBar, PageTabs } from "./PageNav";

/** One grey placeholder bar; decorative, so screen readers skip it (the main landmark carries aria-busy instead). */
const Bar = ({ className }: { className: string }) => <div aria-hidden="true" className={`rounded-lg bg-surface-muted ${className}`} />;

/**
 * v8 Part 2c: the planner's server-rendered frame. The plan lives in this browser's localStorage, which the server can't
 * read, so the server (and the hydration pass) render this instead: the header frame, the page navigation, the open
 * page's h1 and a neutral content skeleton. It depends only on the pathname, so server and client agree on every byte.
 * Nothing here comes from a plan (not even a sample's name), so a stored plan never flashes the wrong event. ClientRoot
 * swaps in PlannerApp right after hydration. Both navigation variants render and CSS picks one by width (no matchMedia).
 */
export default function AppShell() {
  const pathname = usePathname();
  const setup = isSetupPath(pathname);
  const page = pageForPath(pathname);
  const current = setup ? null : page.id;
  return (
    <div className="min-h-dvh w-full" data-testid="app-shell">
      <a href="#main" className="sr-only rounded-lg bg-sand-900 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:px-4 focus:py-3">Skip to main content</a>
      <header className="festive-rule relative z-30 border-b border-line bg-surface/95 backdrop-blur md:sticky md:top-0">
        <div className="mx-auto flex max-w-[100rem] items-center gap-2.5 px-3 py-2 sm:px-4">
          <div aria-hidden="true" className="logo-tile grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm"><PartyPopper size={18} /></div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Utsav Co-Pilot</p>
            <Bar className="mt-1 h-5 w-40 max-w-full" />
          </div>
        </div>
        <div className="hidden md:block"><PageTabs current={current} /></div>
      </header>
      <main id="main" tabIndex={-1} aria-busy="true" data-testid="app-shell-main"
        className="min-w-0 px-3 pb-[calc(var(--fab-space)+env(safe-area-inset-bottom))] pt-4 focus-visible:outline-none max-md:pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--fab-space))] sm:px-4 lg:px-6 lg:pt-6">
        <div className="mx-auto max-w-[100rem]">
          <h1 data-testid="shell-heading" className="break-words text-2xl font-semibold leading-tight text-ink sm:text-3xl">{setup ? SETUP_TITLE : page.title}</h1>
          {!setup && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{page.description}</p>}
          <div className="mt-5 grid gap-4 motion-safe:animate-pulse md:grid-cols-3">
            <Bar className="h-24" /><Bar className="h-24" /><Bar className="h-24" />
            <Bar className="h-56 md:col-span-2" /><Bar className="h-56" />
          </div>
        </div>
      </main>
      <div className="md:hidden"><PageTabBar current={current} /></div>
    </div>
  );
}
