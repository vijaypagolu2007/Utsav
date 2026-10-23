"use client";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";

// The planner reads localStorage and "today" on first render, so it renders client-only (no hydration mismatch).
// The (planner) layout renders this once around every organizer page; the page arrives as children and renders
// inside the shell, which keeps the plan state while the route changes.
const PlannerApp = dynamic(() => import("./PlannerApp"), {
  ssr: false,
  loading: () => (
    <div className="grid h-screen place-items-center text-sm text-sand-600">
      <div className="flex items-center gap-3"><span className="h-3 w-3 animate-ping rounded-full bg-brand-500" /> Loading your event canvas…</div>
    </div>
  ),
});

export default function ClientRoot({ children }: { children?: ReactNode }) {
  return <PlannerApp>{children}</PlannerApp>;
}
