"use client";
// First run (no saved plans in this browser): plan your own event, explore one of the sample plans, or sign in.
// Existing users never see this; they go straight to their saved plan.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Cake, CheckCircle2, Heart, LogIn, Megaphone, PartyPopper, Sparkles, type LucideIcon } from "lucide-react";
import { SIGNIN_PATH } from "@/signin";
import { TEMPLATES, templateLabel, type TemplateId } from "@/config/event-templates";
import { pageTitle } from "@/routes";
import type { SetupInputRaw } from "@/setup";
import type { CreatePlanResult } from "./PlannerApp";
import SetupWizard from "./SetupWizard";

const ICON: Record<string, LucideIcon> = { wedding: Heart, birthday: Cake, community: Megaphone };

export default function Welcome({ onCreate, onSample }: { onCreate: (s: SetupInputRaw) => Promise<CreatePlanResult>; onSample: (t: TemplateId) => void }) {
  const [planning, setPlanning] = useState(false);
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const started = useRef(false);
  useEffect(() => { document.title = pageTitle(planning ? "New plan" : "Welcome"); }, [planning]);
  useEffect(() => { if (started.current && !planning) heading.current?.focus(); started.current = true; }, [planning]);

  return (
    <div className="min-h-dvh w-full bg-canvas">
      <a href="#main" className="sr-only rounded-lg bg-sand-900 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:px-4 focus:py-3">Skip to main content</a>
      <header className="festive-rule relative border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-4 py-3">
          <div aria-hidden="true" className="logo-tile grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm"><PartyPopper size={18} /></div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-muted">Utsav Co-Pilot</p>
          {/* Signing in is optional: it keeps a cloud copy of the plan. Setting up and the samples work without it. */}
          <Link href={SIGNIN_PATH} data-testid="welcome-signin"
            className="ml-auto flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100">
            <LogIn size={16} aria-hidden="true" className="text-brand-700" /> Sign in
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} data-testid="welcome" className="mx-auto max-w-5xl px-4 py-6 focus-visible:outline-none sm:py-10">
        {planning ? (
          <SetupWizard onCreate={onCreate} onCancel={() => setPlanning(false)} cancelLabel="Back to welcome" onDone={() => router.push("/")} />
        ) : (
          <div className="festive-hero space-y-6 rounded-2xl p-5 sm:p-8" data-event-type="wedding">
            <div className="max-w-2xl">
              <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold leading-tight text-ink focus-visible:outline-offset-4 sm:text-4xl">Plan your celebration, your way</h1>
              <p className="mt-2 text-base text-ink-muted">Weddings, birthdays and community festivals: tell us the basics and your budget, and the Co-Pilot drafts the sub-events, tasks, timeline and ideas. Every rupee is computed by code, never guessed.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <section aria-labelledby="welcome-plan" className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <h2 id="welcome-plan" className="flex items-center gap-2 text-lg font-semibold text-ink"><Sparkles size={18} aria-hidden="true" className="text-brand-700" />Plan my event</h2>
                <p className="mt-1 text-sm text-ink-muted">About two minutes: type, city, dates, guests, budget, and anything special. Then choose how much goes where.</p>
                <ul className="mt-3 space-y-1.5 text-sm text-ink">
                  {["Sub-events and tasks that fit your tradition and city", "Your own amounts kept exactly, to the paisa", "Ideas for decor, food, gifts and more, sized to what's left"].map(t => (
                    <li key={t} className="flex items-start gap-2"><CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-700" />{t}</li>
                  ))}
                </ul>
                <button type="button" onClick={() => setPlanning(true)} data-testid="welcome-plan"
                  className="mt-4 flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover">
                  Start planning<ArrowRight size={16} aria-hidden="true" />
                </button>
              </section>
              <section aria-labelledby="welcome-sample" className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <h2 id="welcome-sample" className="text-lg font-semibold text-ink">Explore a sample</h2>
                <p className="mt-1 text-sm text-ink-muted">See a fully planned event first. You can start your own any time from More, New plan.</p>
                <ul className="mt-3 space-y-2">
                  {TEMPLATES.map(t => {
                    const Icon = ICON[t.eventType] ?? PartyPopper;
                    return (
                      <li key={t.id}>
                        <button type="button" onClick={() => onSample(t.id as TemplateId)} data-testid={`explore-sample-${t.id}`}
                          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left text-sm font-medium text-ink hover:bg-sand-100">
                          <Icon size={16} aria-hidden="true" className="shrink-0 text-maroon-700" /><span className="min-w-0 flex-1">{templateLabel(t)}</span><ArrowRight size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
