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

/** Order matters: chips render in this order, organizer prompts first by scenario, then guest prompts. */
const DEFINITIONS = [
  // Organizer: the five judge scenarios, shown for every event type.
  { id: "judge-cut-and-move", audience: "organizer", text: "Cut ₹20k from decor and move the Haldi to Friday", hint: "slack-proportional cut + weekday resolve + cascade" },
  { id: "judge-over-cut", audience: "organizer", text: "Cut ₹1.5L from decor", hint: "atomic rollback + self-healing counter-offer" },
  { id: "judge-phase-violation", audience: "organizer", text: "Move the Haldi to Monday", hint: "phase invariant rejection" },
  { id: "judge-insights", audience: "organizer", text: "Which vendor deposits are overdue and what tasks are urgent?", hint: "proactive insights" },
  { id: "judge-cold-start", audience: "organizer", text: "Switch to a 30th Retro Arcade Birthday for ₹1.5L", hint: "cold-start blueprint + ext polymorphism" },
  // Organizer: one Tier 2 outbound draft per event type.
  { id: "draft-photographer-whatsapp", audience: "organizer", eventTypes: ["wedding"], text: "Draft a WhatsApp to negotiate the photographer's quote", hint: "Tier 2 outbound draft" },
  { id: "birthday-overdue-wishes", audience: "organizer", eventTypes: ["birthday"], text: "What's overdue and which wishes are unclaimed?", hint: "Tier 2 outbound draft" },
  { id: "draft-sponsor-pitch", audience: "organizer", eventTypes: ["community"], text: "Draft a sponsor pitch for SpiceRoute Foods", hint: "Tier 2 outbound draft" },

  // Guest concierge.
  { id: "guest-sangeet-dress-code", audience: "guest", eventTypes: ["wedding"], text: "What is the dress code and venue for Sangeet?", hint: "guest-safe" },
  { id: "guest-rsvp-haldi", audience: "guest", eventTypes: ["wedding"], text: "RSVP yes for Anil Sharma to Haldi", hint: "guest-safe" },
  { id: "guest-household-rsvp-jain", audience: "guest", eventTypes: ["wedding"], text: "Mark the Sharma household as attending Haldi and Reception with 2 Jain meals", hint: "guest-safe" },
  { id: "guest-tries-budget-cut", audience: "guest", eventTypes: ["wedding"], text: "Cut ₹20k from decor", hint: "guest-safe" },
  { id: "guest-unclaimed-wishes", audience: "guest", eventTypes: ["birthday"], text: "Which birthday wishes are still unclaimed?", hint: "guest-safe" },
  { id: "guest-claim-polaroid", audience: "guest", eventTypes: ["birthday"], text: "Claim the Retro Polaroid Camera from the birthday wishlist.", hint: "guest-safe" },
  { id: "guest-party-time", audience: "guest", eventTypes: ["birthday"], text: "What time does the party start and what should I wear?", hint: "guest-safe" },
  { id: "guest-volunteer-signup", audience: "guest", eventTypes: ["community"], text: "Sign Ravi Kumar up to volunteer for the Cultural Night", hint: "guest-safe" },
  { id: "guest-sponsor-interest", audience: "guest", eventTypes: ["community"], text: "Bright Ideas Pvt Ltd wants to sponsor at gold tier", hint: "guest-safe" },
  { id: "guest-main-stage-time", audience: "guest", eventTypes: ["community"], text: "When is the Main Stage & Food Court?", hint: "guest-safe" },
] as const satisfies readonly z.input<typeof DemoPrompt>[];

/** Validated once at module load; a broken entry fails the build and the test suite, not a user's click. */
export const DEMO_PROMPTS: readonly DemoPrompt[] = Object.freeze(DemoPromptList.parse(DEFINITIONS).map(p => Object.freeze(p)));
export type DemoPromptId = (typeof DEFINITIONS)[number]["id"];

/** The chips for one audience and event type, in configured order. */
export function promptsFor(audience: PromptAudience, eventType: EventType): readonly DemoPrompt[] {
  return DEMO_PROMPTS.filter(p => p.audience === audience && (!p.eventTypes || p.eventTypes.includes(eventType)));
}
