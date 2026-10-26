// v8 Part 0b: "My events" versus "Samples", and the one-time choice a new account makes on its first sign-in.
// Pure decisions (no React, no Firebase) plus one small per-device record, so all of it is unit tested.
//
// Storage is unchanged: one plan history per template slot ("wedding", "birthday", "community"). What a slot holds is
// read from the plan itself:
//   - a pristine sample: exactly the template's seed (same fingerprint);
//   - an edited sample: the seed's event (same event id), changed since;
//   - the organizer's own event: a plan with a different event id (the setup form or an AI blueprint made it).
// A sample is never written to a signed-in organizer's cloud account until they pick "Load sample events" or edit it.
import type { AgentState } from "./schema";
import { planHash } from "./cloud-sync";
import { inrShort } from "./budget-a11y";
import { instantiateTemplate, TEMPLATES, type TemplateId } from "./config/event-templates";
import type { Store } from "./persistence";

/** Short event-type names for the switcher's second line. */
export const EVENT_TYPE_LABEL: Record<AgentState["event"]["eventType"], string> = { wedding: "Wedding", birthday: "Birthday", community: "Community event" };

const seedHashes = new Map<string, string>();
/** The fingerprint of a template's untouched seed (computed once per slot). */
export function seedHash(slot: TemplateId): string {
  let h = seedHashes.get(slot);
  if (!h) { h = planHash(instantiateTemplate(slot)); seedHashes.set(slot, h); }
  return h;
}
/** The slot holds its sample exactly as shipped. */
export const isPristineSample = (slot: TemplateId, plan: AgentState): boolean => planHash(plan) === seedHash(slot);
/** The slot holds the organizer's own event (not the sample, edited or not). */
export function isOwnEvent(slot: TemplateId, plan: Pick<AgentState, "event">): boolean {
  const t = TEMPLATES.find(x => x.id === slot);
  return !!t && plan.event.id !== t.seed.event.id;
}

const current = (s: Store, slot: TemplateId): AgentState | null => { const h = s.byType[slot]; return h ? h.snaps[h.idx]!.plan : null; };

/** Anything on this device worth keeping: an edited sample or an event of the organizer's own, in any slot. */
export function hasMeaningfulLocalEdits(s: Store): boolean {
  return TEMPLATES.some(t => { const p = current(s, t.id as TemplateId); return !!p && !isPristineSample(t.id as TemplateId, p); });
}

// ---------- the event switcher ----------
export type SwitcherEntry = {
  slot: TemplateId;
  /** First line: the event's own title (mine), or the sample's name (samples). */
  title: string;
  /** Second line: type and budget ("Birthday · ₹3L"). */
  detail: string;
  /** Samples only: the slot's title when it was renamed ("now: …"), else null. */
  now: string | null;
  /** Samples only: edited since it was loaded. */
  edited: boolean;
  active: boolean;
};
export type SwitcherSections = {
  mine: SwitcherEntry[];
  samples: SwitcherEntry[];
  /** Samples whose slot holds an event of the organizer's own (one event per type for now), so they can't open. */
  covered: { slot: TemplateId; name: string; type: string }[];
  /** v8 Part 0d: samples deleted on this device (not listed until "Restore samples" brings fresh copies back). */
  removed: TemplateId[];
};

/**
 * v8 Part 0d: the slot's sample was deleted on this device and nothing of the organizer's own has taken its place, so
 * the slot shows nothing (it is not listed, never syncs, and its stored plan is only a placeholder).
 */
export function sampleRemoved(s: Store, slot: TemplateId): boolean {
  if (!s.removedSamples?.includes(slot)) return false;
  const plan = current(s, slot);
  return !plan || !isOwnEvent(slot, plan);
}
/** v8 Part 0d: every event is gone (own events deleted, every sample deleted): the planner shows the setup form. */
export const hasNoEvents = (s: Store): boolean => TEMPLATES.every(t => sampleRemoved(s, t.id as TemplateId));
/** v8 Part 0d: the store with `slot` no longer marked as a deleted sample (something real now uses the slot). */
export function unmarkRemoved(s: Store, slot: TemplateId): Store {
  if (!s.removedSamples?.includes(slot)) return s;
  const rest = s.removedSamples.filter(x => x !== slot);
  const out: Store = { ...s, removedSamples: rest };
  if (!rest.length) delete out.removedSamples;
  return out;
}

/** What the switcher lists: the organizer's own events first, then the samples, in registry order. */
export function switcherSections(s: Store): SwitcherSections {
  const out: SwitcherSections = { mine: [], samples: [], covered: [], removed: [] };
  for (const t of TEMPLATES) {
    const slot = t.id as TemplateId;
    const plan = current(s, slot) ?? t.seed;
    const detail = `${EVENT_TYPE_LABEL[plan.event.eventType]} · ${inrShort(plan.event.totalBudgetPaise)}`;
    const active = s.active === slot;
    if (isOwnEvent(slot, plan)) {
      out.mine.push({ slot, title: plan.event.title, detail, now: null, edited: false, active });
      out.covered.push({ slot, name: t.name, type: EVENT_TYPE_LABEL[t.eventType].toLowerCase() });
    } else if (sampleRemoved(s, slot)) {
      out.removed.push(slot);
    } else {
      const stored = current(s, slot);
      const now = stored && stored.event.title !== t.seed.event.title ? stored.event.title : null;
      out.samples.push({ slot, title: t.name, detail, now, edited: !!stored && !isPristineSample(slot, stored), active });
    }
  }
  return out;
}

// ---------- the first sign-in choice ----------
/** localStorage: { [uid]: "own" | "samples" }, the answer each account gave on this device. */
export const FIRST_CHOICE_KEY = "utsav_first_choice_v1";
export type FirstChoice = "own" | "samples";
/** What the cloud holds for this account across the template slots: not asked yet, nothing, something, or unknown (failed). */
export type CloudPlans = "unknown" | "none" | "some" | "error";

export type FirstChoiceInput = {
  signedIn: boolean;
  /** This account already chose on this device. */
  answered: boolean;
  cloudPlans: CloudPlans;
  /** hasMeaningfulLocalEdits: the device has something of its own to upload, so the usual sync flow runs instead. */
  localEdits: boolean;
};
/**
 * Show "Start your own event / Load sample events" only to a signed-in account that hasn't answered on this device,
 * whose cloud account is known to be empty, and whose device holds nothing but untouched samples. Any doubt (the
 * cloud check failed or is still running) means no chooser: the samples simply stay local.
 */
export function shouldShowFirstChoice(i: FirstChoiceInput): boolean {
  return i.signedIn && !i.answered && i.cloudPlans === "none" && !i.localEdits;
}

/** Whether to ask the cloud at all (it costs one request per slot): only while the answer could still show the chooser. */
export const needsCloudProbe = (i: Omit<FirstChoiceInput, "cloudPlans">): boolean => i.signedIn && !i.answered && !i.localEdits;

/**
 * May this device create the cloud copy of a slot that has none yet? Always for the organizer's own events and edited
 * samples; a pristine sample only after this account picked "Load sample events". (A slot that already has a cloud
 * copy syncs as before: it is already in the account.)
 */
export function mayCreateCloudCopy(i: { pristineSample: boolean; choice: FirstChoice | null }): boolean {
  return !i.pristineSample || i.choice === "samples";
}

const local = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
function readAll(): Record<string, unknown> {
  try {
    const j = JSON.parse(local()?.getItem(FIRST_CHOICE_KEY) ?? "{}") as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch { return {}; }
}
export function loadFirstChoice(uid: string | null | undefined): FirstChoice | null {
  if (!uid) return null;
  const all = readAll();
  const v = Object.prototype.hasOwnProperty.call(all, uid) ? all[uid] : null;
  return v === "own" || v === "samples" ? v : null;
}
export function saveFirstChoice(uid: string, choice: FirstChoice): void {
  if (!uid) return;
  const all = readAll();
  all[uid] = choice;
  try { local()?.setItem(FIRST_CHOICE_KEY, JSON.stringify(all)); } catch { /* storage blocked: the chooser may show again */ }
}
