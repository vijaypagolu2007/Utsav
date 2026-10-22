// The public projection of an event: the ONLY shape a shared guest link ever receives. It is built with an
// explicit allowlist (never by deleting fields from the plan), so a new private field added to the schema can't
// leak by accident. No money, vendors, tasks, sponsors, permits, phone numbers, invite codes or other households.
import { SponsorTier, type AgentState, type RsvpStatus } from "./schema";
import { visibleSubEventIds } from "./visibility";

export type GuestViewSubEvent = {
  id: string; slug: string; name: string; date: string; startMin: number; endMin: number;
  venue: string; dressCode: string; isMain: boolean; collectsRsvp: boolean;
};
export type GuestViewMember = { id: string; name: string; diet: string[]; rsvp: Record<string, RsvpStatus> };
export type GuestView = {
  eventId: string;
  version: number;
  title: string;
  eventType: AgentState["event"]["eventType"];
  city: string;
  startDate: string;
  endDate: string;
  hosts: string;
  subEvents: GuestViewSubEvent[];
  /** Fixed public moments (muhurtham, cake cutting): anchored blocks only. */
  moments: { subEventId: string; label: string; startMin: number; endMin: number }[];
  /** Present only with a valid household invite token: that household's members, nobody else's. */
  household: { label: string; members: GuestViewMember[] } | null;
  wishlist: { id: string; item: string; priority: "low" | "med" | "high"; claimed: boolean; claimedByYourHousehold: boolean }[] | null;
  community: { volunteersSignedUp: number; sponsorTiers: string[] } | null;
};

export function toGuestView(plan: AgentState, eventId: string, version: number, householdId: string | null): GuestView {
  const e = plan.event, x = e.ext;
  const hh = householdId ? plan.households.find(h => h.id === householdId) ?? null : null;
  const members = hh ? plan.guests.filter(g => g.householdId === hh.id) : [];
  const memberIds = new Set(members.map(m => m.id));
  // Server-side visibility filter: private sub-events never enter the payload unless this household is invited.
  const visible = visibleSubEventIds(plan, memberIds);
  return {
    eventId, version,
    title: e.title, eventType: e.eventType, city: e.city, startDate: e.startDate, endDate: e.endDate,
    hosts: x.type === "wedding" ? x.partners.filter(Boolean).join(" & ") : x.type === "birthday" ? x.honoree : x.organizer,
    subEvents: plan.subEvents.filter(s => visible.has(s.id)).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin).map(s => ({
      id: s.id, slug: s.slug, name: s.name, date: s.date, startMin: s.startMin, endMin: s.endMin,
      venue: s.venue, dressCode: s.dressCode, isMain: s.isMain, collectsRsvp: s.collectsRsvp,
    })),
    moments: plan.timeline.filter(b => b.anchored && visible.has(b.subEventId)).map(b => ({ subEventId: b.subEventId, label: b.label, startMin: b.startMin, endMin: b.endMin })),
    household: hh ? { label: hh.label, members: members.map(g => ({ id: g.id, name: g.name, diet: [...g.diet], rsvp: { ...g.rsvp } })) } : null,
    wishlist: x.type === "birthday" ? x.wishlist.map(w => ({
      id: w.id, item: w.item, priority: w.priority, claimed: w.claimedByGuestId !== null,
      claimedByYourHousehold: w.claimedByGuestId !== null && memberIds.has(w.claimedByGuestId),
    })) : null,
    community: x.type === "community" ? { volunteersSignedUp: x.volunteerSignups.length, sponsorTiers: [...SponsorTier.options] } : null,
  };
}
