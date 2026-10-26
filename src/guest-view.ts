// The public projection of an event: the ONLY shape a shared guest link ever receives. It is built with an
// explicit allowlist (never by deleting fields from the plan), so a new private field added to the schema can't
// leak by accident. No money, vendors, tasks, sponsors, permits, phone numbers, emails, invite codes, join requests,
// the change log, the guest list or anybody else's RSVP.
//
// v8 Part 1c: two kinds of access.
//   • public  no token: the itinerary of public sub-events and the wishlist (claims hidden in surprise mode).
//   • open    the event's RSVP link (or an old Part 1 household link): the itinerary of every sub-event that takes RSVPs,
//             the RSVP form (functions, close date, the kids question) and, when this device has answered before, its own
//             RSVP (`mine`) so the form opens prefilled. Never a phone number, not even the guest's own: `mine.hasPhone`
//             only says one is on file. Never another entry, not even a count of them.
import { SponsorTier, type AgentState, type RsvpAnswer, type RsvpMeal } from "./schema";
import { visibleSubEventIds } from "./visibility";
import { isSafeWishlistUrl } from "./commands";
import { rsvpClosed, rsvpFunctions } from "./rsvp";

export type GuestViewSubEvent = {
  id: string; slug: string; name: string; date: string; startMin: number; endMin: number;
  venue: string; dressCode: string; isMain: boolean; collectsRsvp: boolean;
};
/** This device's own RSVP: what the form is prefilled with. */
export type GuestViewMine = {
  entryId: string; name: string; partySize: number; kids: number | null; functions: string[]; meal: RsvpMeal; answer: RsvpAnswer;
  /** A phone is on file (the number itself is never sent back). */
  hasPhone: boolean;
  /** The server flagged it: another device sent an RSVP with the same phone. */
  duplicate: boolean;
  /** The organizer removed it: the form is read-only and says so. */
  removed: boolean;
  updatedAt: string;
};
export type GuestAccess =
  | { kind: "public" }
  /** entryId: this device's own RSVP entry (from the device token), or null when it hasn't answered. */
  | { kind: "open"; entryId?: string | null };
export type GuestView = {
  eventId: string;
  version: number;
  /** v8 Part 1c: which kind of link this is (see the header comment). */
  mode: GuestAccess["kind"];
  title: string;
  eventType: AgentState["event"]["eventType"];
  city: string;
  startDate: string;
  endDate: string;
  hosts: string;
  subEvents: GuestViewSubEvent[];
  /** Fixed public moments (muhurtham, cake cutting): anchored blocks only. */
  moments: { subEventId: string; label: string; startMin: number; endMin: number }[];
  /** v8 Part 1c: the RSVP form, on the RSVP link only (null on the public link). */
  rsvp: { functions: { id: string; slug: string; name: string; date: string }[]; askKids: boolean; closesAt: string | null; closed: boolean; maxParty: number } | null;
  /** v8 Part 1c: this device's own RSVP, or null. */
  mine: GuestViewMine | null;
  /**
   * Birthday wishlist or wedding registry. Never says WHO claimed a gift. `claimedByYou` is set only for a gift this
   * device's RSVP claimed, so it can be released; `url` only when it is a safe https link.
   */
  wishlist: { id: string; item: string; priority: "low" | "med" | "high"; url: string | null; claimed: boolean; claimedByYou: boolean }[] | null;
  /** "wishlist" (birthday) or "registry" (wedding); null when the event has neither. */
  wishlistKind: "wishlist" | "registry" | null;
  /** Surprise mode on a link that can't claim (no RSVP yet): claims are hidden (every `claimed` is false). */
  claimsHidden: boolean;
  community: { volunteersSignedUp: number; sponsorTiers: string[] } | null;
};

/**
 * Build the projection for one kind of access (null: the public link). `now` decides whether the form is closed (the
 * server passes its clock; tests pass a fixed one).
 */
export function toGuestView(plan: AgentState, eventId: string, version: number, access: GuestAccess | null, now: string = new Date().toISOString()): GuestView {
  const a: GuestAccess = access ?? { kind: "public" };
  const e = plan.event, x = e.ext;
  const open = a.kind === "open";
  const entry = open && a.entryId ? plan.rsvpEntries.find(r => r.id === a.entryId && !r.mergedInto) ?? null : null;
  const live = !!entry && !entry.removedAt;
  // The RSVP link is the invitation: it shows every sub-event that takes RSVPs (private ones included). The public link
  // shows only public ones (server-side visibility filter, src/visibility.ts).
  const fns = rsvpFunctions(plan);
  const visible = open ? new Set([...visibleSubEventIds(plan, []), ...fns.map(s => s.id)]) : visibleSubEventIds(plan, []);
  // Surprise mode: a page that can't claim (no live RSVP: the honoree may well open it) shows the list but not the claims.
  const hideClaims = (x.type === "birthday" || x.type === "wedding") && x.wishlistSurprise && !live;
  return {
    eventId, version, mode: open ? "open" : "public",
    title: e.title, eventType: e.eventType, city: e.city, startDate: e.startDate, endDate: e.endDate,
    hosts: x.type === "wedding" ? x.partners.filter(Boolean).join(" & ") : x.type === "birthday" ? x.honoree : x.organizer,
    subEvents: plan.subEvents.filter(s => visible.has(s.id)).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin).map(s => ({
      id: s.id, slug: s.slug, name: s.name, date: s.date, startMin: s.startMin, endMin: s.endMin,
      venue: s.venue, dressCode: s.dressCode, isMain: s.isMain, collectsRsvp: s.collectsRsvp,
    })),
    moments: plan.timeline.filter(b => b.anchored && visible.has(b.subEventId)).map(b => ({ subEventId: b.subEventId, label: b.label, startMin: b.startMin, endMin: b.endMin })),
    rsvp: open ? {
      functions: fns.map(s => ({ id: s.id, slug: s.slug, name: s.name, date: s.date })),
      askKids: plan.rsvpSettings.askKids, closesAt: plan.rsvpSettings.closesAt, closed: rsvpClosed(plan.rsvpSettings, now), maxParty: 20,
    } : null,
    mine: entry ? {
      entryId: entry.id, name: entry.name, partySize: entry.partySize, kids: entry.kids, functions: entry.functions.filter(f => fns.some(s => s.id === f)),
      meal: entry.meal, answer: entry.answer, hasPhone: !!entry.phone, duplicate: !!entry.possibleDuplicateOf, removed: !!entry.removedAt, updatedAt: entry.updatedAt,
    } : null,
    wishlist: x.type === "birthday" || x.type === "wedding" ? x.wishlist.map(w => {
      const mine = live && w.claimedByGuestId === entry!.id;
      return { id: w.id, item: w.item, priority: w.priority, url: w.url && isSafeWishlistUrl(w.url) ? w.url : null,
        claimed: hideClaims ? false : w.claimedByGuestId !== null, claimedByYou: mine };
    }) : null,
    wishlistKind: x.type === "birthday" ? "wishlist" : x.type === "wedding" ? "registry" : null,
    claimsHidden: hideClaims,
    community: x.type === "community" ? { volunteersSignedUp: x.volunteerSignups.length, sponsorTiers: [...SponsorTier.options] } : null,
  };
}
