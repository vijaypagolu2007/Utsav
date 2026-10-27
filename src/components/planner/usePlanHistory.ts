"use client";
// The plan state: every event slot's undo/redo history (persisted), the highlight, and the only way the plan changes
// (commitWith → the deterministic reducer). Moved out of PlannerApp in v8 Part 2, unchanged apart from the debounced
// save (setStore's `now` writes storage right away for changes that must be on disk at once).
// Refs mirror state for synchronous reads inside handlers (storeRef), exactly as before.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentState } from "@/schema";
import { applyBatch, type BatchInput, type BatchResult, type BatchSource, type Role } from "@/commands";
import { computePlanDiff } from "@/diff";
import { todayIST } from "@/insights";
import { type History, type Store, flushStore, freshHistory, historyOf, loadStore, saveStore } from "@/persistence";
import { requireTemplate, slotFor, templateLabel, type TemplateId } from "@/config/event-templates";
import { unmarkRemoved } from "@/my-events";
import { pageForPath, pagesForDiff, type PlannerPage } from "@/routes";
import { newId } from "./ids";
import type { ToastFn } from "./useToasts";
import type { Commit, Highlight, ToastLink } from "./types";

let highlightSeq = 0;
export const linksTo = (pages: PlannerPage[]): ToastLink[] => pages.map(p => ({ href: p.href, label: p.label }));

export function usePlanHistory(pathRef: RefObject<string>, toast: ToastFn) {
  const [store, setStoreState] = useState<Store>(() => loadStore());
  const storeRef = useRef(store);
  // v8 Part 2 fix: leaving the (planner) layout (client navigation to /signin) unmounts this hook; write the pending save
  // now, so whatever reads storage next (the planner remounting on the way back) sees the latest edit.
  useEffect(() => () => { flushStore(); }, []);
  const [today, setTodayState] = useState(() => store.today ?? todayIST());
  const [highlight, setHighlight] = useState<Highlight>({ ids: new Set(), key: 0 });
  // Pages an AI change (or undo, or a guest sync) touched other than the one on screen: linked from the drawer and toasts.
  const [elsewhere, setElsewhere] = useState<PlannerPage[]>([]);
  const hist = historyOf(store);
  const plan = hist.snaps[hist.idx]!.plan;

  // ---------- state plumbing (refs mirror state for synchronous reads inside handlers) ----------
  const setStore = (s: Store, now = false) => { storeRef.current = s; setStoreState(s); saveStore(s); if (now) flushStore(); };
  // v8 Part 0d: whatever lands in a slot (an edit, a new event, a cloud copy, Undo) makes it a listed slot again.
  const setHist = (h: History, t: TemplateId = storeRef.current.active) => setStore(unmarkRemoved({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: h } }, t));
  const setToday = (d: string) => { setTodayState(d); setStore({ ...storeRef.current, today: d }); };
  const currentHist = () => historyOf(storeRef.current);
  const current = () => { const h = currentHist(); return h.snaps[h.idx]!.plan; };

  // Stable (it only touches state setters), so the page-focus effect in PlannerApp can list it without re-running.
  const flash = useCallback((ids: string[]) => {
    const key = ++highlightSeq; // alternates hl-a / hl-b, so a new highlight restarts the pulse
    setHighlight({ ids: new Set(ids), key });
    setTimeout(() => setHighlight(h => (h.key === key ? { ids: new Set(), key } : h)), 3100);
  }, []);
  /**
   * The highlight pulses on whatever part is on screen. A change the user didn't make on this page (an AI proposal,
   * undo, a sync) can land on another page, so `notify` returns those pages and lists them for the Co-Pilot drawer.
   */
  const showChanges = (before: AgentState, after: AgentState, notify: boolean): PlannerPage[] => {
    const diff = computePlanDiff(before, after);
    flash(diff.changedIds);
    if (!notify) return [];
    const off = before.event.id === after.event.id ? pagesForDiff(diff.rows, pageForPath(pathRef.current).id) : [];
    setElsewhere(off);
    return off;
  };
  const push = (next: AgentState, label: string, notify = true): PlannerPage[] => {
    const t = slotFor(storeRef.current.active, next);
    const h = historyOf(storeRef.current, t);
    const before = h.snaps[h.idx]!.plan;
    setHist({ snaps: [...h.snaps.slice(0, h.idx + 1), { plan: next, label }].slice(-50), idx: Math.min(h.idx + 1, 49) }, t);
    return showChanges(before, next, notify);
  };
  const switchTemplate = (t: TemplateId) => {
    if (t === storeRef.current.active) return;
    setStore({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: historyOf(storeRef.current, t) } }, true);
    flash([]);
  };
  const resetTemplate = () => {
    const t = storeRef.current.active;
    setHist(freshHistory(t), t);
    toast("slate", `Reset to the clean ${templateLabel(requireTemplate(t))} preset`);
  };
  const goTo = (idx: number) => {
    const h = currentHist();
    if (idx < 0 || idx >= h.snaps.length || idx === h.idx) return;
    const before = h.snaps[h.idx]!.plan, after = h.snaps[idx]!.plan;
    setHist({ ...h, idx });
    const off = showChanges(before, after, true);
    if (off.length) toast("slate", `${idx < h.idx ? "Undid" : "Redid"}: ${h.snaps[idx < h.idx ? h.idx : idx]!.label}`, linksTo(off));
  };

  return { store, storeRef, setStore, setHist, today, setToday, hist, plan, currentHist, current, highlight, flash, elsewhere, setElsewhere, push, switchTemplate, resetTemplate, goTo };
}
export type PlanHistory = ReturnType<typeof usePlanHistory>;

/**
 * The only way the canvas changes: through the deterministic reducer, under the current role. The dashboard's own
 * controls commit with source "ui" (which also allows the inline-edit ops); AI proposals keep the default "agent".
 */
export function usePlanCommits(h: PlanHistory, role: Role, actingEntryId: string | null, toast: ToastFn, dismissAction: (testId: string) => void) {
  const { current, currentHist, push, goTo } = h;
  const commitWith = (r: Role, batch: BatchInput, label?: string, source: BatchSource = "agent"): BatchResult => {
    // `now` stamps the organizer's RSVP change log (v8 Part 1). Previews and dry runs leave it out, so they log nothing.
    // v8 Part 1c: in Guest View the preview acts as one RSVP entry, so it may only change that entry.
    const res = applyBatch(current(), batch, { role: r, source, now: new Date().toISOString(), ...(r === "guest" && actingEntryId ? { actorEntryId: actingEntryId } : {}) });
    if (res.ok) {
      // A direct edit is made on the page that shows it; anything else may have changed another page too.
      const off = push(res.state, label ?? batch.summary, source !== "ui");
      toast("emerald", `Applied: ${res.log.join(" · ") || batch.summary}`, linksTo(off));
    }
    else toast("rose", `Not applied: ${res.reason}`);
    return res;
  };
  const commit: Commit = (batch, label) => commitWith(role, batch, label, "ui");
  /**
   * v8 Part 1e: a dashboard edit whose toast carries Undo for UNDO_MS (10 s), like deleting an event. Undo steps the
   * history back only while this edit is still the latest step; after another edit the header's Undo/Redo is the way back.
   */
  const commitUndoable: Commit = (batch, label) => {
    const res = applyBatch(current(), batch, { role, source: "ui", now: new Date().toISOString() });
    if (!res.ok) { toast("rose", `Not applied: ${res.reason}`); return res; }
    push(res.state, label ?? batch.summary, false);
    const testId = newId("undo-edit");
    toast("slate", `${res.log.join(" · ") || batch.summary}.`, undefined, { label: "Undo", testId, onClick: () => {
      dismissAction(testId);
      const hh = currentHist();
      if (hh.snaps[hh.idx]?.plan === res.state && hh.idx > 0) goTo(hh.idx - 1);
      else toast("rose", "Not undone: the plan changed since. Use Undo in the header.");
    } });
    return res;
  };
  const loadPlan = (p: AgentState, label: string) => { push(p, label); toast("emerald", `Loaded ${p.event.title}`); };
  return { commitWith, commit, commitUndoable, loadPlan };
}
