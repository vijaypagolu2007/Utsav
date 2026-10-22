// KPI tiles in the header: what each one is called, who sees it and in what order.
// The numbers are not here: each id maps to a calculation in src/kpis.ts (a typed registry of plain functions over
// the plan), so this file stays serializable data and the money/date maths stays in one tested place.
import { z } from "zod";
import { EventType } from "../schema";

export const KPI_IDS = ["total-budget", "planned", "committed", "paid", "days-to-event", "rsvp-summary", "itinerary", "rsvp-attending"] as const;
export type KpiId = (typeof KPI_IDS)[number];
export const KpiAudience = z.enum(["organizer", "guest"]);
export type KpiAudience = z.infer<typeof KpiAudience>;

export const KpiDefinition = z.strictObject({
  id: z.enum(KPI_IDS),
  /** Visible label. It also forms the tile's test id (kpi-<label>), which the end-to-end tests use. */
  label: z.string().min(1).max(24),
  /** What the figure means, used as the tile's tooltip. */
  description: z.string().min(1).max(160),
  /** Views the tile appears in. Organizer tiles may show money; guest tiles never do. */
  audiences: z.array(KpiAudience).nonempty(),
  /** Event types the tile applies to. Omitted = all. */
  eventTypes: z.array(EventType).nonempty().optional(),
});
export type KpiDefinition = z.infer<typeof KpiDefinition>;

const MONEY_KPIS: readonly KpiId[] = ["total-budget", "planned", "committed", "paid"];

export const KpiDefinitionList = z.array(KpiDefinition).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((k, i) => {
    if (seen.has(k.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate KPI "${k.id}"` });
    seen.add(k.id);
    // Configuration can't put a money figure in front of guests.
    if (MONEY_KPIS.includes(k.id) && k.audiences.includes("guest")) ctx.addIssue({ code: "custom", path: [i, "audiences"], message: `"${k.id}" is organizer-only` });
  });
});

/** In display order. */
const DEFINITIONS = [
  { id: "total-budget", label: "Total budget", description: "The overall budget for the event.", audiences: ["organizer"] },
  { id: "planned", label: "Planned", description: "Sum of every budget line's planned envelope, against the total.", audiences: ["organizer"] },
  { id: "committed", label: "Committed", description: "Signed or contracted spend, as a share of the total budget.", audiences: ["organizer"] },
  { id: "paid", label: "Paid", description: "Payments recorded as paid, and what is still owed on commitments.", audiences: ["organizer"] },
  { id: "days-to-event", label: "Days to event", description: "Days from the planning date to the main event.", audiences: ["organizer", "guest"] },
  { id: "rsvp-summary", label: "RSVP", description: "Yes answers out of guests invited to the main event.", audiences: ["organizer"] },
  { id: "itinerary", label: "Events", description: "Number of sub-events on the itinerary.", audiences: ["guest"] },
  { id: "rsvp-attending", label: "RSVP", description: "Guests attending the main event and replies still due.", audiences: ["guest"] },
] as const satisfies readonly z.input<typeof KpiDefinition>[];

export const KPI_DEFINITIONS: readonly KpiDefinition[] = Object.freeze(KpiDefinitionList.parse(DEFINITIONS).map(k => Object.freeze(k)));

/** The tiles for one view and event type, in configured order. */
export const kpisFor = (audience: KpiAudience, eventType: EventType): readonly KpiDefinition[] =>
  KPI_DEFINITIONS.filter(k => k.audiences.includes(audience) && (!k.eventTypes || k.eventTypes.includes(eventType)));

/** Stable test id, unchanged from the hand-written tiles: "Days to event" → "kpi-days-to-event". */
export const kpiTestId = (label: string) => `kpi-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
