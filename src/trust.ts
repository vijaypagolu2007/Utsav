// 3-tier trust model. Tier 0 auto-applies, Tier 1 needs a dry-run diff approval, Tier 2 is an outbound draft
// that a human sends. The tier is decided deterministically from the commands, never by the LLM.
import { GUEST_LIST_OPS, RSVP_ORGANIZER_OPS, V6_OPS, type Command } from "./commands";

export type TrustTier = 0 | 1 | 2;
/** Budget moves at or above this need approval: ₹25,000. */
export const TIER1_BUDGET_THRESHOLD_PAISE = 25_000_00;

export function commandTier(c: Command): TrustTier {
  switch (c.op) {
    case "adjust_budget": return Math.abs(c.deltaPaise) >= TIER1_BUDGET_THRESHOLD_PAISE ? 1 : 0;
    case "move_sub_event": return 1;
    // Publishing exposes details to anyone holding the link, so it needs approval; hiding is always safe.
    case "set_sub_event_visibility": return c.visibility === "public" ? 1 : 0;
    case "record_payment": return 1;
    case "update_sponsor": return c.receivedPaise !== undefined ? 1 : 0;
    case "upsert_vendor_quote": return 1; // always: a quote changes money and vendor terms
    case "set_guest_diet": case "community_signup": return 0;
    // Direct edits from the organizer's own controls. Renames are always safe; an amount follows the adjust_budget rule.
    case "rename_event": case "set_partner_names": case "rename_entity": return 0;
    case "set_planned_amount": return Math.abs(c.plannedPaise - c.expectedPaise) >= TIER1_BUDGET_THRESHOLD_PAISE ? 1 : 0;
    // Plan structure. A new line follows the ₹25,000 money rule; deleting a line, changing the event basics,
    // rebalancing every envelope and adopting an idea (task + money) always show a dry-run diff first.
    case "add_budget_item": return c.plannedPaise >= TIER1_BUDGET_THRESHOLD_PAISE ? 1 : 0;
    case "remove_budget_item": case "set_event_basics": case "rebalance_budget": case "adopt_idea": return 1;
    // v6: priorities, the vendor shortlist and task dependencies move no money or dates (Tier 0). Booking a vendor is a
    // commitment and removing one loses its quotes, so both show a dry-run first.
    case "set_priorities": case "add_vendor": case "set_vendor_need": case "set_task_dependency": return 0;
    case "set_vendor_stage": return c.stage === "booked" ? 1 : 0;
    case "remove_vendor": return 1;
    // The idea board itself moves no money or dates.
    case "add_ideas": case "save_idea": case "dismiss_idea": return 0;
    // v8 Part 0c: deleting the event is never automatic. The card needs Approve, then the app's own confirm.
    case "delete_event": return 2;
    // v8 Part 1: adding and editing people and gifts is reversible with Undo (Tier 0). Removing someone, a bulk import
    // (many people at once) and declining a join request show a dry-run card first. Approving a join request adds a
    // household, the same as add_household. request_join is a guest's own pending request: it changes nothing visible.
    case "add_household": case "update_household": case "add_guest": case "update_guest": case "approve_join_request": return 0;
    case "remove_household": case "remove_guest": case "import_guests": case "reject_join_request": return 1;
    case "add_wishlist_item": case "update_wishlist_item": case "set_wishlist_surprise": return 0;
    case "remove_wishlist_item": return 1;
    case "unclaim_wishlist_item": case "request_join": return 0;
    // v8 Part 1c: a guest's own RSVP is Tier 0. Marking a VIP or restoring an RSVP is undoable (Tier 0); removing one,
    // merging two, and changing the close date or the form (which every guest sees) show a dry-run card first.
    case "submit_rsvp_entry": case "set_rsvp_vip": case "restore_rsvp_entry": return 0;
    case "remove_rsvp_entry": case "merge_rsvp_entries": case "set_rsvp_settings": return 1;
    case "set_task_status": case "set_rsvp": case "shift_block": case "set_item_lock":
    case "claim_wishlist_item": case "set_permit_status":
      return 0;
  }
}

/** A batch takes the highest tier of any command in it. */
export function batchTier(commands: Command[]): TrustTier {
  return commands.reduce<TrustTier>((t, c) => (commandTier(c) > t ? commandTier(c) : t), 0);
}

/**
 * The tier an AI proposal is shown at. Same as batchTier, except that a batch with any v6 op (priorities, vendors,
 * dependencies), a v8 guest-list / wishlist op or a v8 Part 1c RSVP-list op is never auto-applied for the AI: the organiser approves it on a card, even when its own tier is 0.
 */
export function agentBatchTier(commands: Command[]): TrustTier {
  const t = batchTier(commands);
  return commands.some(c => V6_OPS.has(c.op) || GUEST_LIST_OPS.has(c.op) || RSVP_ORGANIZER_OPS.has(c.op)) ? (Math.max(1, t) as TrustTier) : t;
}

export const TIER_LABEL: Record<TrustTier, string> = {
  0: "Auto-applied",
  1: "Needs your approval",
  2: "Draft — you send it",
};
