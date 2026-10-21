// LocalStorage persistence: the active archetype plus an undo/redo history per archetype.
// Every snapshot is re-validated with Zod on load, so a corrupt or outdated entry can never reach the reducer.
import { AgentState } from "./schema";
import { PRESETS } from "./presets";

export const STORAGE_KEY = "genai_event_planner_v1";
export const MAX_SNAPSHOTS = 25;

export type EventType = AgentState["event"]["eventType"];
export type Snapshot = { plan: AgentState; label: string };
export type History = { snaps: Snapshot[]; idx: number };
export type Store = { active: EventType; byType: Partial<Record<EventType, History>>; today?: string };

export const presetFor = (t: EventType) => PRESETS.find(p => p.key === t)!;
export const freshHistory = (t: EventType): History => ({ snaps: [{ plan: presetFor(t).plan, label: `Loaded ${presetFor(t).label}` }], idx: 0 });
export const defaultStore = (): Store => ({ active: "wedding", byType: { wedding: freshHistory("wedding") } });
export const historyOf = (s: Store, t: EventType = s.active): History => s.byType[t] ?? freshHistory(t);

export function serializeStore(s: Store): string {
  const byType: Store["byType"] = {};
  for (const [t, h] of Object.entries(s.byType) as [EventType, History][]) {
    const start = Math.max(0, h.snaps.length - MAX_SNAPSHOTS);
    byType[t] = { snaps: h.snaps.slice(start), idx: Math.max(0, h.idx - start) };
  }
  return JSON.stringify({ v: 1, active: s.active, byType, ...(s.today ? { today: s.today } : {}) });
}

/** Parse whatever is in storage; anything invalid falls back to the clean presets. */
export function parseStore(raw: string | null): Store {
  if (!raw) return defaultStore();
  try {
    const j = JSON.parse(raw) as { v?: number; active?: string; today?: string; byType?: Record<string, { snaps?: { plan: unknown; label?: string }[]; idx?: number }> };
    if (j.v !== 1 || !j.byType) return defaultStore();
    const out: Store = { active: "wedding", byType: {} };
    for (const t of ["wedding", "birthday", "community"] as const) {
      const h = j.byType[t];
      if (!h?.snaps?.length) continue;
      const snaps: Snapshot[] = [];
      for (const s of h.snaps) {
        const p = AgentState.safeParse(s.plan);
        if (p.success && p.data.event.eventType === t) snaps.push({ plan: p.data, label: String(s.label ?? "Restored") });
      }
      if (snaps.length) out.byType[t] = { snaps, idx: Math.min(Math.max(0, Number(h.idx) || 0), snaps.length - 1) };
    }
    if (typeof j.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.today)) out.today = j.today;
    out.active = j.active === "birthday" || j.active === "community" ? j.active : "wedding";
    if (!out.byType[out.active]) out.byType[out.active] = freshHistory(out.active);
    return out;
  } catch {
    return defaultStore();
  }
}

export function loadStore(): Store {
  if (typeof window === "undefined") return defaultStore();
  try { return parseStore(window.localStorage.getItem(STORAGE_KEY)); } catch { return defaultStore(); }
}

export function saveStore(s: Store): boolean {
  if (typeof window === "undefined") return false;
  try { window.localStorage.setItem(STORAGE_KEY, serializeStore(s)); return true; } catch { return false; }
}
