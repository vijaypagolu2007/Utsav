// LocalStorage persistence: the active template plus an undo/redo history per template slot.
// Every snapshot is re-validated with Zod on load, so a corrupt or outdated entry can never reach the reducer.
//
// Storage format (unchanged, v: 1): { v, active, byType: { [slot]: { snaps, idx } }, today? }.
// Slots are template ids. The three original templates use the ids "wedding", "birthday" and "community", which are
// exactly the keys this format has always used, so existing saved plans load as-is with no migration.
// A slot whose template no longer exists is kept verbatim (never dropped) and written back on save.
import { AgentState } from "./schema";
import { DEFAULT_TEMPLATE_ID, getTemplate, instantiateTemplate, isTemplateId, requireTemplate, templateLabel, TEMPLATES, type TemplateId } from "./config/event-templates";

export const STORAGE_KEY = "genai_event_planner_v1";
export const MAX_SNAPSHOTS = 25;

export type EventType = AgentState["event"]["eventType"];
export type Snapshot = { plan: AgentState; label: string };
export type History = { snaps: Snapshot[]; idx: number };
export type Store = {
  active: TemplateId;
  byType: Partial<Record<TemplateId, History>>;
  today?: string;
  /** Saved slots for templates this build doesn't know (raw, untouched), preserved across saves. */
  retired?: Record<string, unknown>;
  /**
   * v8 Part 0d: samples the organizer deleted on this device (template ids). Such a slot is not listed under Samples
   * until "Restore samples" / "Load sample events" brings a fresh copy back, or an event of the organizer's own (or a
   * restored one) takes the slot. Older builds ignore the field.
   */
  removedSamples?: TemplateId[];
};

/** A slot's starting point: a fresh copy of its template, never a shared reference. */
export const freshHistory = (id: TemplateId): History => ({ snaps: [{ plan: instantiateTemplate(id), label: `Loaded ${templateLabel(requireTemplate(id))}` }], idx: 0 });
export const defaultStore = (): Store => ({ active: DEFAULT_TEMPLATE_ID, byType: { [DEFAULT_TEMPLATE_ID]: freshHistory(DEFAULT_TEMPLATE_ID) } });
export const historyOf = (s: Store, id: TemplateId = s.active): History => s.byType[id] ?? freshHistory(id);

export function serializeStore(s: Store, maxSnapshots: number = MAX_SNAPSHOTS): string {
  const byType: Record<string, unknown> = { ...s.retired };
  for (const [t, h] of Object.entries(s.byType) as [TemplateId, History][]) {
    const start = Math.max(0, h.snaps.length - maxSnapshots);
    byType[t] = { snaps: h.snaps.slice(start), idx: Math.max(0, h.idx - start) };
  }
  return JSON.stringify({ v: 1, active: s.active, byType, ...(s.today ? { today: s.today } : {}), ...(s.removedSamples?.length ? { removedSamples: s.removedSamples } : {}) });
}

type RawHistory = { snaps?: { plan: unknown; label?: string }[]; idx?: number };

/** Parse whatever is in storage; anything invalid falls back to clean templates. */
export function parseStore(raw: string | null): Store {
  if (!raw) return defaultStore();
  try {
    const j = JSON.parse(raw) as { v?: number; active?: string; today?: string; byType?: Record<string, RawHistory>; removedSamples?: unknown };
    if (j.v !== 1 || !j.byType || typeof j.byType !== "object") return defaultStore();
    const out: Store = { active: DEFAULT_TEMPLATE_ID, byType: {} };
    for (const [key, h] of Object.entries(j.byType)) {
      const template = getTemplate(key);
      if (!template) {
        if (key !== "__proto__" && key !== "constructor" && key !== "prototype") (out.retired ??= {})[key] = h;
        continue;
      }
      if (!h?.snaps?.length) continue;
      const snaps: Snapshot[] = [];
      for (const s of h.snaps) {
        const p = AgentState.safeParse(s.plan);
        if (p.success && p.data.event.eventType === template.eventType) snaps.push({ plan: p.data, label: String(s.label ?? "Restored") });
      }
      if (snaps.length) out.byType[template.id as TemplateId] = { snaps, idx: Math.min(Math.max(0, Number(h.idx) || 0), snaps.length - 1) };
    }
    if (typeof j.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.today)) out.today = j.today;
    if (Array.isArray(j.removedSamples)) {
      const removed = TEMPLATES.map(t => t.id as TemplateId).filter(id => (j.removedSamples as unknown[]).includes(id));
      if (removed.length) out.removedSamples = removed;
    }
    out.active = isTemplateId(j.active) ? j.active : DEFAULT_TEMPLATE_ID;
    if (!out.byType[out.active]) out.byType[out.active] = freshHistory(out.active);
    return out;
  } catch {
    return defaultStore();
  }
}

/** Saved title per template slot (null when the slot hasn't been touched), for the event switcher. */
export const storedTitles = (s: Store): Record<string, string | null> =>
  Object.fromEntries(TEMPLATES.map(t => { const h = s.byType[t.id as TemplateId]; return [t.id, h ? h.snaps[h.idx]!.plan.event.title : null]; }));

export function loadStore(): Store {
  if (typeof window === "undefined") return defaultStore();
  try { return parseStore(window.localStorage.getItem(STORAGE_KEY)); } catch { return defaultStore(); }
}

// ---------- first run ----------
/** Set once the organiser has picked "Plan my event" or "Explore a sample" on the welcome screen. */
export const ONBOARDING_KEY = "utsav_onboarding_v1";
/**
 * A first run is a browser with no saved plans that has never been past the welcome screen. Anyone with saved state
 * (every existing user) goes straight to their plan, exactly as before.
 */
export function isFirstRun(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === null && window.localStorage.getItem(ONBOARDING_KEY) !== "done"; } catch { return false; }
}
export function markOnboarded(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ONBOARDING_KEY, "done"); } catch { /* storage full or blocked: the welcome may show again */ }
}

/**
 * Save the store. v8 Part 1: a big guest list (hundreds of imported households plus the change log) times 25 undo steps
 * can pass the browser's ~5 MB localStorage quota, so a failed write retries with a shorter undo history (5, then 1
 * step per event) instead of silently keeping nothing.
 */
export function saveStore(s: Store): boolean {
  if (typeof window === "undefined") return false;
  for (const n of [MAX_SNAPSHOTS, 5, 1]) {
    try { window.localStorage.setItem(STORAGE_KEY, serializeStore(s, n)); return true; } catch { /* quota: try a shorter history */ }
  }
  return false;
}
