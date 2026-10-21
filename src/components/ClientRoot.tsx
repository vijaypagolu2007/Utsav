"use client";
import dynamic from "next/dynamic";

// The planner reads localStorage and "today" on first render, so it renders client-only (no hydration mismatch).
const PlannerApp = dynamic(() => import("./PlannerApp"), {
  ssr: false,
  loading: () => (
    <div className="grid h-screen place-items-center text-sm text-slate-500">
      <div className="flex items-center gap-3"><span className="h-3 w-3 animate-ping rounded-full bg-violet-500" /> Loading your event canvas…</div>
    </div>
  ),
});

export default function ClientRoot() {
  return <PlannerApp />;
}
