"use client";
import { useInsertionEffect, useRef, useState } from "react";

type Handlers = Record<string, (...args: never[]) => unknown>;

/**
 * v8 Part 2: stable identities for handlers that are rebuilt on every render (so they always see the latest state).
 * Each returned function keeps its identity for the component's lifetime and calls the newest version, so the memoized
 * PlannerContext value doesn't change on every render (a toast timer re-renders the shell, not every page).
 * The newest versions are swapped in by an insertion effect: before any layout effect or event handler can call them.
 * Not for calling during render. The set of keys must not change between renders.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  useInsertionEffect(() => { latest.current = handlers; });
  const [stable] = useState(() => {
    const out: Record<string, (...args: unknown[]) => unknown> = {};
    for (const k of Object.keys(handlers)) out[k] = (...args: unknown[]) => (latest.current[k] as unknown as (...a: unknown[]) => unknown)(...args);
    return out as unknown as T;
  });
  return stable;
}
