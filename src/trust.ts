// 3-tier trust model. Tier 0 auto-applies, Tier 1 needs a dry-run diff approval, Tier 2 is an outbound draft
// that a human sends. The tier is decided deterministically from the commands, never by the LLM.
import type { Command } from "./commands";

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
    case "set_task_status": case "set_rsvp": case "shift_block": case "set_item_lock":
    case "claim_wishlist_item": case "set_permit_status":
      return 0;
  }
}

/** A batch takes the highest tier of any command in it. */
export function batchTier(commands: Command[]): TrustTier {
  return commands.reduce<TrustTier>((t, c) => (commandTier(c) > t ? commandTier(c) : t), 0);
}

export const TIER_LABEL: Record<TrustTier, string> = {
  0: "Auto-applied",
  1: "Needs your approval",
  2: "Draft — you send it",
};
