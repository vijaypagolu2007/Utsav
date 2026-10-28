"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import PlannerApp from "./PlannerApp";
import AppShell from "./AppShell";

const subscribe = () => () => {};
/** False on the server and during hydration, true from the first client render after it (and on any later client mount). */
const useHydrated = () => useSyncExternalStore(subscribe, () => true, () => false);

// v8 Part 2c: the server renders AppShell (header frame, page navigation, the page's h1, a neutral skeleton), so the
// first HTML is a real page instead of a blank loading pulse. The plan lives in this browser's localStorage, so
// PlannerApp (which reads it, the theme and auth state while rendering) mounts right after hydration and never on the
// server; a client navigation into the (planner) group mounts it directly. The (planner) layout renders this once around
// every organizer page; the page arrives as children and renders inside the shell, which keeps the plan state while
// the route changes.
export default function ClientRoot({ children }: { children?: ReactNode }) {
  return useHydrated() ? <PlannerApp>{children}</PlannerApp> : <AppShell />;
}
