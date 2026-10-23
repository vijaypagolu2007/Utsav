// Demo prompts: the suggestion chips in the Co-Pilot drawer.
// A prompt is only text. Clicking a chip sends that text through exactly the same path as typing it
// (POST /api/chat → tool call → reducer → diff card → approval), so a prompt can never run a command,
// skip validation or approve anything by itself. The schema is strict to keep it that way: an unknown key
// (for example "commands" or "autoApprove") makes the list invalid.
import { z } from "zod";
import { EventType } from "../schema";

export const PromptAudience = z.enum(["organizer", "guest"]);

export const DemoPrompt = z.strictObject({
  /** Stable id: lowercase words joined by hyphens. Tests and analytics refer to prompts by id, never by text. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** Exactly what is sent to the Co-Pilot, as if the user had typed it. */
  text: z.string().trim().min(1).max(500),
  /** Short note under the chip saying what the prompt demonstrates. */
  hint: z.string().min(1).max(80),
  audience: PromptAudience,
  /** Event types the prompt makes sense for. Omitted = every event type. */
  eventTypes: z.array(EventType).nonempty().optional(),
  /** Slug of a sub-event the prompt names ("haldi"). The chip is hidden on plans without it, e.g. a user's own Christian wedding. */
  requires: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});
export type DemoPrompt = z.infer<typeof DemoPrompt>;
export type PromptAudience = z.infer<typeof PromptAudience>;

export const DemoPromptList = z.array(DemoPrompt).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((p, i) => {
    if (seen.has(p.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate prompt id "${p.id}"` });
    seen.add(p.id);
  });
});

/** Order matters: chips render in this order, organizer prompts first by scenario, then guest prompts. Hints are plain user language. */
const DEFINITIONS = [
  // Organizer, wedding: the flagship scenarios (they name the wedding's own sub-events).
  { id: "judge-cut-and-move", requires: "haldi", audience: "organizer", eventTypes: ["wedding"], text: "Cut ₹20k from decor and move the Haldi to Friday", hint: "Trims decor and reschedules in one go; you approve first" },
  { id: "judge-over-cut", audience: "organizer", eventTypes: ["wedding"], text: "Cut ₹1.5L from decor", hint: "Asks for too much: see what can be cut instead" },
  { id: "judge-phase-violation", requires: "haldi", audience: "organizer", eventTypes: ["wedding"], text: "Move the Haldi to Monday", hint: "Keeps your events in the right order" },
  // Organizer, birthday and community: the same scenarios with their own sub-events.
  { id: "birthday-cut-and-move", requires: "brunch", audience: "organizer", eventTypes: ["birthday"], text: "Cut ₹5k from decor and move the brunch to Sunday", hint: "Trims decor and reschedules in one go; you approve first" },
  { id: "community-cut-and-move", requires: "cultural-night", audience: "organizer", eventTypes: ["community"], text: "Cut ₹20k from decor and move the cultural night to Saturday", hint: "Trims decor and reschedules in one go; you approve first" },
  // Organizer, every event type. v6 first: the stress test revises the plan (one approval card), it never restarts it.
  { id: "stress-test-revise", audience: "organizer", text: "Our budget dropped by ₹50,000 and the event is 2 weeks earlier", hint: "Revises budget and dates in one card, cutting by your priorities" },
  { id: "judge-insights", audience: "organizer", text: "Which vendor deposits are overdue and what tasks are urgent?", hint: "What needs your attention right now" },
  { id: "ideas-for-event", audience: "organizer", text: "Give me ideas for decor, food and return gifts", hint: "Personalised ideas that fit what's left in your budget" },
  { id: "rebalance-total", audience: "organizer", text: "Rebalance to my total", hint: "Spreads spare money across unlocked lines; you approve first" },
  { id: "judge-cold-start", audience: "organizer", text: "Switch to a 30th Retro Arcade Birthday for ₹1.5L", hint: "Drafts a whole new plan from one sentence" },
  // Organizer: one message draft per event type (you send it yourself).
  { id: "draft-photographer-whatsapp", audience: "organizer", eventTypes: ["wedding"], text: "Draft a WhatsApp to negotiate the photographer's quote", hint: "A message you can edit and send yourself" },
  { id: "birthday-overdue-wishes", audience: "organizer", eventTypes: ["birthday"], text: "What's overdue and which wishes are unclaimed?", hint: "Deposits and gifts still waiting" },
  { id: "draft-sponsor-pitch", audience: "organizer", eventTypes: ["community"], text: "Draft a sponsor pitch for SpiceRoute Foods", hint: "A message you can edit and send yourself" },

  // Guest concierge.
  { id: "guest-sangeet-dress-code", requires: "sangeet", audience: "guest", eventTypes: ["wedding"], text: "What is the dress code and venue for Sangeet?", hint: "Guests can ask this" },
  { id: "guest-rsvp-haldi", requires: "haldi", audience: "guest", eventTypes: ["wedding"], text: "RSVP yes for Anil Sharma to Haldi", hint: "Guests can ask this" },
  { id: "guest-household-rsvp-jain", requires: "haldi", audience: "guest", eventTypes: ["wedding"], text: "Mark the Sharma household as attending Haldi and Reception with 2 Jain meals", hint: "Guests can ask this" },
  { id: "guest-tries-budget-cut", audience: "guest", eventTypes: ["wedding"], text: "Cut ₹20k from decor", hint: "Guests can ask this" },
  { id: "guest-unclaimed-wishes", audience: "guest", eventTypes: ["birthday"], text: "Which birthday wishes are still unclaimed?", hint: "Guests can ask this" },
  { id: "guest-claim-polaroid", audience: "guest", eventTypes: ["birthday"], text: "Claim the Retro Polaroid Camera from the birthday wishlist.", hint: "Guests can ask this" },
  { id: "guest-party-time", audience: "guest", eventTypes: ["birthday"], text: "What time does the party start and what should I wear?", hint: "Guests can ask this" },
  { id: "guest-volunteer-signup", requires: "cultural-night", audience: "guest", eventTypes: ["community"], text: "Sign Ravi Kumar up to volunteer for the Cultural Night", hint: "Guests can ask this" },
  { id: "guest-sponsor-interest", audience: "guest", eventTypes: ["community"], text: "Bright Ideas Pvt Ltd wants to sponsor at gold tier", hint: "Guests can ask this" },
  { id: "guest-main-stage-time", requires: "main-stage", audience: "guest", eventTypes: ["community"], text: "When is the Main Stage & Food Court?", hint: "Guests can ask this" },
] as const satisfies readonly z.input<typeof DemoPrompt>[];

/** Validated once at module load; a broken entry fails the build and the test suite, not a user's click. */
export const DEMO_PROMPTS: readonly DemoPrompt[] = Object.freeze(DemoPromptList.parse(DEFINITIONS).map(p => Object.freeze(p)));
export type DemoPromptId = (typeof DEFINITIONS)[number]["id"];

/** The chips for a plan: its audience and event type, minus any that name a sub-event this plan doesn't have. */
export function promptsForPlan(audience: PromptAudience, plan: { event: { eventType: z.infer<typeof EventType> }; subEvents: { slug: string }[] }): readonly DemoPrompt[] {
  return promptsFor(audience, plan.event.eventType).filter(p => !p.requires || plan.subEvents.some(s => s.slug === p.requires));
}

/** The chips for one audience and event type, in configured order. */
export function promptsFor(audience: PromptAudience, eventType: EventType): readonly DemoPrompt[] {
  return DEMO_PROMPTS.filter(p => p.audience === audience && (!p.eventTypes || p.eventTypes.includes(eventType)));
}
