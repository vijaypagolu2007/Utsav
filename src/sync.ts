// Organizer ⇄ server merge. When the organizer syncs, the client pulls the server copy and rebases guest-owned
// fields onto its local plan, then pushes with baseVersion. With `base` (the copy both sides last agreed on) the
// merge is three-way: a guest-owned field takes the server value only if the server changed it since `base`,
// so an organizer's own edit to the same field is never silently overwritten. Without `base` (first sync after
// a reload with no stored base) the server copy wins for guest-owned fields.
import { JOIN_RECORDS_CAP, RSVP_ENTRIES_CAP, RSVP_LOG_CAP, type AgentState, type RsvpEntry } from "./schema";

type Rsvp = AgentState["guests"][number]["rsvp"];
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Guest-writable fields: RSVP answers (not invitations), diets, wishlist claims, community sign-ups, (v8) join requests
 * and change-log entries, and (v8 Part 1c) the open RSVP list. RSVP settings (close date, kids question) are the organizer's.
 */
export function rebaseGuestFields(local: AgentState, remote: AgentState, base?: AgentState | null): AgentState {
  const rGuests = new Map(remote.guests.map(g => [g.id, g]));
  const bGuests = new Map((base?.guests ?? []).map(g => [g.id, g]));
  const guests = local.guests.map(g => {
    const r = rGuests.get(g.id);
    if (!r) return g;
    const b = base ? bGuests.get(g.id) : undefined;
    const rsvp: Rsvp = { ...g.rsvp };
    // The organizer owns which sub-events a guest is invited to (the keys); the guest owns the answer.
    for (const k of Object.keys(rsvp)) {
      const a = r.rsvp[k];
      if (!a) continue;
      const serverChanged = base ? a !== b?.rsvp[k] : a !== "invited";
      if (serverChanged) rsvp[k] = a;
    }
    const dietChanged = base ? !eq(r.diet, b?.diet ?? []) : true;
    return { ...g, rsvp, diet: dietChanged ? [...r.diet] : g.diet };
  });

  let ext = local.event.ext;
  const rx = remote.event.ext, bx = base?.event.ext;
  // Wishlist (birthday) and gift registry (wedding, v8 Part 1): claims and releases are guest-owned.
  if ((ext.type === "birthday" || ext.type === "wedding") && rx.type === ext.type) {
    const rClaims = new Map(rx.wishlist.map(w => [w.id, w.claimedByGuestId]));
    const bClaims = new Map(bx?.type === ext.type ? bx.wishlist.map(w => [w.id, w.claimedByGuestId]) : []);
    ext = { ...ext, wishlist: ext.wishlist.map(w => {
      if (!rClaims.has(w.id)) return w;
      const rc = rClaims.get(w.id)!;
      const serverChanged = base ? rc !== (bClaims.get(w.id) ?? null) : rc !== null;
      return serverChanged ? { ...w, claimedByGuestId: rc } : w;
    }) };
  }
  if (ext.type === "community" && rx.type === "community") {
    const baseVs = new Set(bx?.type === "community" ? bx.volunteerSignups.map(v => v.id) : []);
    const baseSp = new Set(bx?.type === "community" ? bx.sponsors.map(s => s.id) : []);
    const localVs = new Map(ext.volunteerSignups.map(v => [v.id, v]));
    const localSp = new Map(ext.sponsors.map(s => [s.id, s]));
    const fresh = (taken: Set<string>, id: string) => { let n = 2, x = `${id}-r`; while (taken.has(x)) x = `${id}-r${n++}`; return x; };
    const takenVs = new Set(localVs.keys()), takenSp = new Set(localSp.keys());
    const addVs: typeof ext.volunteerSignups = [], addSp: typeof ext.sponsors = [];
    for (const v of rx.volunteerSignups) {
      if (baseVs.has(v.id)) continue;           // already known to both sides
      const mine = localVs.get(v.id);
      if (mine && eq(mine, v)) continue;        // same record on both sides
      // Ids are derived from list length, so an organizer-side and a guest-side sign-up can collide: re-id, never drop.
      const id = mine ? fresh(takenVs, v.id) : v.id;
      takenVs.add(id); addVs.push({ ...v, id });
    }
    for (const s of rx.sponsors) {
      if (!s.id.startsWith("sp-g") || baseSp.has(s.id)) continue;
      const mine = localSp.get(s.id);
      if (mine && eq(mine, s)) continue;
      if ([...localSp.values()].some(x => x.name.toLowerCase() === s.name.toLowerCase())) continue;
      const id = mine ? fresh(takenSp, s.id) : s.id;
      takenSp.add(id); addSp.push({ ...s, id });
    }
    if (addVs.length || addSp.length)
      ext = { ...ext, volunteers: ext.volunteers + addVs.length, volunteerSignups: [...ext.volunteerSignups, ...addVs], sponsors: [...ext.sponsors, ...addSp] };
  }
  return { ...local, guests, event: { ...local.event, ext }, joinRequests: mergeJoinRequests(local, remote, base), rsvpLog: mergeLog(local, remote, base),
    rsvpEntries: mergeRsvpEntries(local, remote, base) };
}

/** The fields a guest writes on the open RSVP form (plus the server's duplicate flag). */
const GUEST_ENTRY_FIELDS = ["name", "phone", "partySize", "kids", "functions", "meal", "answer", "updatedAt"] as const;
/**
 * v8 Part 1c. RSVP entries arrive on the server (the open link); the organizer marks VIPs, removes and merges them locally.
 *   • An entry only the server has is added (a new RSVP), unless `base` had it (the organizer's side dropped it: kept out).
 *   • For an entry both sides have, the guest-owned fields take the server copy when the guest changed them since `base`
 *     (compared by updatedAt; without a base, the server copy wins). vip, removedAt and mergedInto stay the organizer's.
 *   • possibleDuplicateOf: the server sets it; the organizer clears it by merging or removing. The server value wins only
 *     when it changed since `base` and the entry is still live here.
 */
function mergeRsvpEntries(local: AgentState, remote: AgentState, base?: AgentState | null): RsvpEntry[] {
  const bMap = new Map((base?.rsvpEntries ?? []).map(e => [e.id, e]));
  const lMap = new Map(local.rsvpEntries.map(e => [e.id, e]));
  const rMap = new Map(remote.rsvpEntries.map(e => [e.id, e]));
  let changed = false;
  const out = local.rsvpEntries.map(l => {
    const r = rMap.get(l.id);
    if (!r) return l;
    const b = base ? bMap.get(l.id) : undefined;
    let next: RsvpEntry = l;
    const guestChanged = base ? (r.updatedAt !== (b?.updatedAt ?? null)) : r.updatedAt !== l.updatedAt;
    if (guestChanged && r.updatedAt >= l.updatedAt) {
      const patch: Partial<RsvpEntry> = {};
      for (const k of GUEST_ENTRY_FIELDS) (patch as Record<string, unknown>)[k] = r[k];
      next = { ...next, ...patch };
    }
    const dupChanged = base ? r.possibleDuplicateOf !== (b?.possibleDuplicateOf ?? null) : r.possibleDuplicateOf !== l.possibleDuplicateOf;
    if (dupChanged && !l.removedAt && !l.mergedInto && r.possibleDuplicateOf !== l.possibleDuplicateOf
      && (r.possibleDuplicateOf === null || lMap.has(r.possibleDuplicateOf))) next = { ...next, possibleDuplicateOf: r.possibleDuplicateOf };
    if (next !== l && !eq(next, l)) { changed = true; return next; }
    return l;
  });
  const add = remote.rsvpEntries.filter(r => !lMap.has(r.id) && !bMap.has(r.id));
  if (!add.length && !changed) return local.rsvpEntries;
  return [...out, ...add].slice(0, RSVP_ENTRIES_CAP);
}

/**
 * v8 Part 1. Join requests arrive on the server (the public join endpoint); the organizer decides them locally. A remote
 * request the organizer has never seen is added; one the organizer already has keeps the organizer's status (approved or
 * declined), so a decision is never undone by a sync. A request in `base` but gone locally was pruned by the cap: not re-added.
 */
function mergeJoinRequests(local: AgentState, remote: AgentState, base?: AgentState | null): AgentState["joinRequests"] {
  const mine = new Set(local.joinRequests.map(r => r.id));
  const known = new Set((base?.joinRequests ?? []).map(r => r.id));
  const add = remote.joinRequests.filter(r => !mine.has(r.id) && !known.has(r.id) && r.status === "pending");
  return add.length ? [...local.joinRequests, ...add].slice(-JOIN_RECORDS_CAP) : local.joinRequests;
}

/** v8 Part 1. The change log is append-only on both sides: union by id, oldest first, newest RSVP_LOG_CAP kept. */
function mergeLog(local: AgentState, remote: AgentState, base?: AgentState | null): AgentState["rsvpLog"] {
  const mine = new Set(local.rsvpLog.map(e => e.id));
  const known = new Set((base?.rsvpLog ?? []).map(e => e.id));
  const add = remote.rsvpLog.filter(e => !mine.has(e.id) && !known.has(e.id));
  if (!add.length) return local.rsvpLog;
  return [...local.rsvpLog, ...add].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-RSVP_LOG_CAP);
}

/** True when the remote copy carries guest-side changes the local plan lacks. */
export function hasGuestChanges(local: AgentState, remote: AgentState, base?: AgentState | null): boolean {
  return !eq(rebaseGuestFields(local, remote, base), local);
}
