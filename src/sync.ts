// Organizer ⇄ server merge. When the organizer syncs, the client pulls the server copy and rebases guest-owned
// fields onto its local plan, then pushes with baseVersion. With `base` (the copy both sides last agreed on) the
// merge is three-way: a guest-owned field takes the server value only if the server changed it since `base`,
// so an organizer's own edit to the same field is never silently overwritten. Without `base` (first sync after
// a reload with no stored base) the server copy wins for guest-owned fields.
import type { AgentState } from "./schema";

type Rsvp = AgentState["guests"][number]["rsvp"];
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Guest-writable fields: RSVP answers (not invitations), diets, wishlist claims, community sign-ups. */
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
  if (ext.type === "birthday" && rx.type === "birthday") {
    const rClaims = new Map(rx.wishlist.map(w => [w.id, w.claimedByGuestId]));
    const bClaims = new Map(bx?.type === "birthday" ? bx.wishlist.map(w => [w.id, w.claimedByGuestId]) : []);
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
  return { ...local, guests, event: { ...local.event, ext } };
}

/** True when the remote copy carries guest-side changes the local plan lacks. */
export function hasGuestChanges(local: AgentState, remote: AgentState, base?: AgentState | null): boolean {
  return !eq(rebaseGuestFields(local, remote, base), local);
}
