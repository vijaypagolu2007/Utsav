"use client";
// The planner's toasts and the polite announcement that mirrors them (moved out of PlannerApp in v8 Part 2).
import { useState } from "react";
import Link from "next/link";
import { UNDO_MS } from "@/trash";
import { newId } from "./ids";
import type { Toast, ToastAction, ToastLink } from "./types";

export type ToastFn = (tone: Toast["tone"], text: string, links?: ToastLink[], action?: ToastAction) => void;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const toast: ToastFn = (tone, text, links, action) => {
    const id = newId("toast");
    setToasts(t => [...t.slice(-3), { id, tone, text, links: links?.length ? links : undefined, action }]);
    setAnnouncement(links?.length ? `${text}. Also changed: ${links.map(l => l.label).join(", ")}.` : text);
    // Errors and toasts with a link stay up longer so there is time to read and use them (WCAG 2.2.1); every toast is
    // also in a polite live region. An Undo toast stays UNDO_MS (10 s); Recently deleted keeps the same choice for 30 days.
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? UNDO_MS : tone === "rose" || links?.length ? 9000 : 4500);
  };
  /** Take down the toast whose action carries this testId (its Undo was just used). */
  const dismissAction = (testId: string) => setToasts(t => t.filter(x => x.action?.testId !== testId));
  return { toasts, toast, dismissAction, announcement, setAnnouncement };
}

/**
 * Toasts sit above the bottom tab bar (and its safe-area inset) on small screens, so they never cover it or the last section,
 * and stop short of the floating Co-Pilot launcher on the right.
 */
export function ToastStack({ toasts, guest }: { toasts: Toast[]; guest: boolean }) {
  return (
    <div role="status" aria-live="polite"
      className={`pointer-events-none fixed left-3 right-[calc(5.25rem+env(safe-area-inset-right))] z-40 flex flex-col gap-2 sm:right-auto sm:max-w-md md:bottom-4 md:left-4 ${guest ? "bottom-[calc(1rem+env(safe-area-inset-bottom))]" : "bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]"}`}>
      {toasts.map(t => (
        <div key={t.id} className={`toast-in pointer-events-auto break-words rounded-xl px-4 py-3 text-sm shadow-lg ${t.tone === "emerald" ? "bg-emerald-700 text-white" : t.tone === "rose" ? "bg-red-700 text-white" : "bg-sand-800 text-white"}`}>
          {t.text}
          {t.action && (
            <button type="button" onClick={t.action.onClick} data-testid="toast-undo"
              className="ml-2 inline-flex min-h-8 items-center rounded-md border border-white/80 px-2.5 font-semibold text-white underline-offset-2 hover:bg-white/10 hover:underline">
              {t.action.label}
            </button>
          )}
          {t.links && !guest && (
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Also changed:</span>
              {t.links.map(l => (
                <Link key={l.href} href={l.href} className="inline-flex min-h-8 items-center font-semibold underline underline-offset-2">
                  View {l.label.toLowerCase()}<span className="sr-only"> page</span>
                </Link>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
