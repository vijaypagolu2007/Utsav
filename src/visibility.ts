// Per-sub-event visibility for shared guest links. The organizer always sees every sub-event.
// A shared link shows: public sub-events, plus private ones that someone in the caller's household is invited to.
// Visibility only controls who can SEE a sub-event; it never grants RSVP permission. RSVP is still limited to the
// sub-events a guest is invited to (the keys of guest.rsvp), enforced by the reducer.
//
// Legacy data: plans saved before this field existed (localStorage or a shared-event record) load through Zod with
// `visibility` defaulted to "private". Nothing is dropped: the sub-event and its data stay intact for the organizer,
// it just stops appearing on the public link until the organizer marks it public. Fail closed, never open.
import type { AgentState, SubEvent } from "./schema";

export type Visibility = "public" | "private";
export const isPublicSubEvent = (s: Pick<SubEvent, "visibility">) => s.visibility === "public";

/** Ids of sub-events a shared-link caller may see. `householdGuestIds` is empty for a link with no invite token. */
export function visibleSubEventIds(plan: AgentState, householdGuestIds: Iterable<string>): Set<string> {
  const ids = new Set(householdGuestIds);
  const invited = new Set(plan.guests.filter(g => ids.has(g.id)).flatMap(g => Object.keys(g.rsvp)));
  return new Set(plan.subEvents.filter(s => isPublicSubEvent(s) || invited.has(s.id)).map(s => s.id));
}

/** The household (all members) of one guest, for guest-mode previews that act as a single guest. */
export function householdOf(plan: AgentState, guestId: string | null): string[] {
  const g = guestId ? plan.guests.find(x => x.id === guestId) : undefined;
  return g ? plan.guests.filter(x => x.householdId === g.householdId).map(x => x.id) : [];
}

export function publicCount(plan: AgentState): { public: number; total: number } {
  return { public: plan.subEvents.filter(isPublicSubEvent).length, total: plan.subEvents.length };
}
