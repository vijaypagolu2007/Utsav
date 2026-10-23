// Cold start: initialize_event_plan turns an LLM-drafted blueprint into a valid AgentState.
// The LLM never emits paise totals or computed dates. It gives relative weights and day offsets;
// this module allocates the budget with the same largest-remainder rule as adjust_budget and resolves every date.
import { z } from "zod";
import { AgentState, BudgetItem, EventType, IsoDate, MinuteOfDay, Priority, SponsorStatus, SponsorTier } from "./schema";
import { addDays, allocateLargestRemainder, checkInvariants, daysBetween, PlanError, plannedTotal } from "./commands";
import { constrainBudgetLines, defaultStyle, resolveSetupBudget, SetupInput, setupDays } from "./setup";

const Category = BudgetItem.shape.category;

const BlueprintSubEvent = z.object({
  name: z.string().min(1).describe("e.g. 'Haldi', 'Cake & Games', 'Main Stage'"),
  dayOffset: z.number().int().min(0).max(30).describe("Days after startDate (0 = first day). The tool computes the date"),
  startMin: MinuteOfDay.describe("Minutes from midnight, 10:00 AM = 600"),
  endMin: MinuteOfDay,
  phase: z.enum(["pre", "main", "post"]).default("pre"),
  isMain: z.boolean().default(false).describe("Exactly one sub-event is the main one"),
  venue: z.string().default(""),
  dressCode: z.string().default(""),
  visibility: z.enum(["public", "private"]).default("private")
    .describe("Shown on the public guest link? Leave private unless the organizer explicitly asked for it to be public"),
});

const BlueprintBudgetLine = z.object({
  category: Category,
  label: z.string().min(1),
  subEvent: z.string().optional().describe("Name of the sub-event this line belongs to"),
  weightBps: z.number().int().positive().max(10000)
    .describe("Relative share in basis points. Weights need not sum to 10000; the tool normalises them and allocates the exact total"),
  basis: z.enum(["flat", "per_guest"]).optional()
    .describe("per_guest for costs that scale with head count (plates, return gifts). Default: catering and gifts are per_guest, everything else flat"),
});

const BlueprintTask = z.object({
  title: z.string().min(1),
  subEvent: z.string().optional().describe("Name of the sub-event the due date hangs off (default: the main event)"),
  dueOffsetDays: z.number().int().min(-400).max(30).describe("-30 = 30 days before that sub-event"),
  priority: Priority.default("med"),
  dependsOn: z.array(z.string()).max(10).default([]).describe("Titles of tasks that must be done first, e.g. venue booking before decor and invitations"),
});

const BlueprintBlock = z.object({
  subEvent: z.string(),
  label: z.string(),
  lane: z.string().default("main"),
  startMin: MinuteOfDay, endMin: MinuteOfDay,
  anchored: z.boolean().default(false).describe("True for fixed rituals such as the Muhurtham"),
});

const BlueprintExt = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wedding"),
    partners: z.tuple([z.string(), z.string()]).default(["", ""]),
    traditions: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("birthday"),
    honoree: z.string().default(""),
    turningAge: z.number().int().positive().nullable().default(null),
    theme: z.string().default(""),
    wishlist: z.array(z.object({ item: z.string(), approxRupees: z.number().int().nonnegative().optional(), priority: Priority.default("med") })).default([]),
    activities: z.array(z.object({
      name: z.string(), ageRange: z.tuple([z.number(), z.number()]).optional(),
      durationMin: z.number().int().positive(), supplies: z.array(z.string()).default([]),
    })).default([]),
  }),
  z.object({
    type: z.literal("community"),
    organizer: z.string().default(""),
    expectedFootfall: z.number().int().nonnegative().default(0),
    volunteers: z.number().int().nonnegative().default(0),
    sponsors: z.array(z.object({
      name: z.string(), tier: SponsorTier,
      pledgedRupees: z.number().int().nonnegative().default(0),
      deliverables: z.array(z.string()).default([]),
      status: SponsorStatus.default("prospect"),
    })).default([]),
    permits: z.array(z.object({
      authority: z.string(), kind: z.string(),
      applyByOffsetDays: z.number().int().max(0).describe("Days before the main event, e.g. -21"),
      feeRupees: z.number().int().nonnegative().default(0),
    })).default([]),
  }),
]);

export const InitializeEventPlan = z.object({
  title: z.string().min(1),
  eventType: EventType,
  city: z.string().default(""),
  startDate: IsoDate.describe("First day of the event window, YYYY-MM-DD"),
  totalBudgetRupees: z.number().int().positive().describe("Whole rupees. ₹25L = 2500000, ₹1.5L = 150000. The tool converts to paise"),
  guestCount: z.number().int().nonnegative().default(0),
  subEvents: z.array(BlueprintSubEvent).min(1).max(12),
  budgetLines: z.array(BlueprintBudgetLine).min(1).max(40),
  tasks: z.array(BlueprintTask).max(60).default([]),
  timeline: z.array(BlueprintBlock).max(80).default([]),
  ext: BlueprintExt,
});
export type InitializeEventPlanInput = z.input<typeof InitializeEventPlan>;

export type InitResult =
  | { ok: true; state: AgentState; log: string[] }
  | { ok: false; reason: string; error: string; diagnostics: { issues: string[]; knownSubEvents: string[] } };

export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

/**
 * Deterministic cold-start reducer. Same blueprint in, same plan out, budget exact to the paisa.
 * With `opts.setup` (the first-run form), the user's answers are hard constraints applied after any AI draft: the
 * basics (type, title, names, city, dates, guests, total, note) are taken from the form, sub-events are kept inside the
 * user's date range, excluded categories are dropped, typed amounts are kept exactly (booked ones committed and
 * locked), and only blank categories are filled from the remainder, by code.
 */
export function initializeEventPlan(input: unknown, opts: { setup?: unknown } = {}): InitResult {
  const fail = (issues: string[], known: string[] = []): InitResult =>
    ({ ok: false, reason: issues.join("; "), error: issues.join("; "), diagnostics: { issues, knownSubEvents: known } });
  const parsed = InitializeEventPlan.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
  let bp = parsed.data;
  let setup: SetupInput | null = null;
  if (opts.setup !== undefined) {
    const sp = SetupInput.safeParse(opts.setup);
    if (!sp.success) return fail(sp.error.issues.map(i => `setup.${i.path.join(".")}: ${i.message}`));
    setup = sp.data;
    if (bp.eventType !== setup.eventType || bp.ext.type !== setup.eventType) return fail([`The draft is a ${bp.eventType} plan but you asked for a ${setup.eventType}`]);
    try { resolveSetupBudget(setup); } catch (e) { if (e instanceof PlanError) return fail([e.message]); throw e; }
    // Sub-events stay inside the user's range; with one date, inside the style's usual length (one day, or a pandal's days).
    const maxOff = setup.endDate ? daysBetween(setup.startDate, setup.endDate) : setupDays({ ...setup, style: setup.style || defaultStyle(setup.eventType) }) - 1;
    const x = bp.ext;
    const ext = x.type === "wedding" ? { ...x, partners: setup.partners && setup.partners.some(Boolean) ? [setup.partners[0] || x.partners[0], setup.partners[1] || x.partners[1]] as [string, string] : x.partners }
      : x.type === "birthday" ? { ...x, honoree: setup.honoree || x.honoree, turningAge: setup.turningAge ?? x.turningAge }
      : { ...x, organizer: setup.organizer || x.organizer, expectedFootfall: setup.guestCount };
    bp = { ...bp, title: setup.title || bp.title, city: setup.city, startDate: setup.startDate, totalBudgetRupees: setup.totalBudgetRupees, guestCount: setup.guestCount,
      subEvents: bp.subEvents.map(s => ({ ...s, dayOffset: Math.min(s.dayOffset, maxOff) })), ext };
  } else if (bp.ext.type !== bp.eventType) return fail([`ext.type "${bp.ext.type}" doesn't match eventType "${bp.eventType}"`]);

  try {
    // Sub-events: slugs, dates and the one main event.
    const used = new Set<string>();
    const subEvents = bp.subEvents.map(s => {
      let slug = slugify(s.name), n = 2;
      while (used.has(slug)) slug = `${slugify(s.name)}-${n++}`;
      used.add(slug);
      if (s.endMin <= s.startMin) throw new PlanError(`${s.name} ends before it starts`);
      return { id: `se-${slug}`, name: s.name, slug, date: addDays(bp.startDate, s.dayOffset), startMin: s.startMin, endMin: s.endMin,
        venue: s.venue, dressCode: s.dressCode, isMain: s.isMain, phase: s.isMain ? ("main" as const) : s.phase, collectsRsvp: true, visibility: s.visibility };
    });
    let mains = subEvents.filter(s => s.isMain);
    if (mains.length === 0) {
      const byPhase = subEvents.find(s => s.phase === "main");
      if (!byPhase) throw new PlanError("Mark exactly one sub-event as isMain");
      byPhase.isMain = true; mains = [byPhase];
    }
    if (mains.length > 1) throw new PlanError(`Only one sub-event can be main; got ${mains.map(m => m.name).join(", ")}`);
    const main = mains[0]!;
    const known = subEvents.map(s => s.slug);
    const ref = (name: string | undefined) => {
      if (!name) return null;
      const r = name.trim().toLowerCase();
      const hit = subEvents.find(s => s.slug === r || s.name.toLowerCase() === r || s.slug === slugify(name));
      if (!hit) throw new PlanError(`Unknown sub-event "${name}" (known: ${known.join(", ")})`);
      return hit.id;
    };

    // Budget: weights → exact paise via largest remainder; with a setup, the user's amounts first (see setup.ts).
    const totalBudgetPaise = bp.totalBudgetRupees * 100;
    let budgetItems;
    if (setup) {
      budgetItems = constrainBudgetLines(bp.budgetLines, setup).map((l, i) => ({ id: `bi-${String(i + 1).padStart(2, "0")}`, category: l.category, label: l.label,
        subEventId: (() => { try { return ref(l.subEvent); } catch { return null; } })(), plannedPaise: l.plannedPaise, committedPaise: l.committedPaise, payments: [], locked: l.locked }));
    } else {
      const lines = bp.budgetLines.map((l, i) => ({ ...l, id: `bi-${String(i + 1).padStart(2, "0")}` }));
      const alloc = allocateLargestRemainder(totalBudgetPaise, lines.map(l => ({ id: l.id, w: l.weightBps })));
      budgetItems = lines.map(l => ({ id: l.id, category: l.category, label: l.label, subEventId: ref(l.subEvent),
        plannedPaise: alloc.get(l.id)!, committedPaise: 0, payments: [], locked: false }));
    }

    // v6: per-guest lines. Catering and return gifts scale with the head count unless the draft says flat (a cake, volunteer
    // meals, or anything booked stays flat). The rate is floor(planned / guests) in paise; the envelope itself is unchanged,
    // so the total stays exact, and a guest-count change later moves it by rate × (new − old).
    if (bp.guestCount > 0) {
      const basisOf = new Map(bp.budgetLines.map(l => [`${l.category}|${l.label}`, l.basis]));
      budgetItems = budgetItems.map(b => {
        const given = basisOf.get(`${b.category}|${b.label}`);
        const per = given ? given === "per_guest" : (b.category === "catering" || b.category === "gifts") && !/cake|volunteer|prasad|bhog/i.test(b.label);
        return per && !b.locked && b.plannedPaise >= bp.guestCount ? { ...b, basis: "per_guest" as const, perGuestPaise: Math.floor(b.plannedPaise / bp.guestCount) } : b;
      });
    }

    const tasks = bp.tasks.map((t, i) => {
      const subEventId = ref(t.subEvent) ?? main.id;
      // A brand-new plan shouldn't open with overdue tasks: with the setup's "today", a deadline already past moves to today.
      const anchor = subEvents.find(s => s.id === subEventId)!.date;
      const floor = setup?.today ? daysBetween(anchor, setup.today) : null;
      const dueOffsetDays = floor !== null && floor <= 0 && t.dueOffsetDays < floor ? floor : t.dueOffsetDays;
      return { id: `tk-${String(i + 1).padStart(2, "0")}`, title: t.title, subEventId, dueOffsetDays, priority: t.priority, status: "todo" as const, column: "todo", dependsOn: [] as string[] };
    });
    // v6: dependencies by title (the draft's), or inferred (venue booking before decor, catering and invitations).
    const byTitle = new Map(tasks.map(t => [t.title.trim().toLowerCase(), t.id]));
    const explicit = bp.tasks.some(t => t.dependsOn.length > 0);
    bp.tasks.forEach((t, i) => {
      const deps = explicit ? t.dependsOn.map(x => byTitle.get(x.trim().toLowerCase())).filter((x): x is string => !!x && x !== tasks[i]!.id) : [];
      tasks[i]!.dependsOn = [...new Set(deps)];
    });
    if (!explicit) inferDependencies(tasks);
    const timeline = bp.timeline.map((b, i) => {
      if (b.endMin <= b.startMin) throw new PlanError(`Block "${b.label}" ends before it starts`);
      return { id: `tl-${String(i + 1).padStart(2, "0")}`, subEventId: ref(b.subEvent)!, label: b.label, lane: b.lane,
        startMin: b.startMin, endMin: b.endMin, anchored: b.anchored };
    });

    const mainDate = main.date;
    const ext = (() => {
      const e = bp.ext;
      switch (e.type) {
        case "wedding": return { ...e, rsvpDeadline: addDays(mainDate, -30) };
        case "birthday": return { ...e,
          wishlist: e.wishlist.map((w, i) => ({ id: `wl-${i + 1}`, item: w.item, priority: w.priority, claimedByGuestId: null,
            ...(w.approxRupees !== undefined ? { approxPaise: w.approxRupees * 100 } : {}) })),
          activities: e.activities.map((a, i) => ({ id: `ac-${i + 1}`, ...a })) };
        case "community": return { type: e.type, organizer: e.organizer, expectedFootfall: e.expectedFootfall, volunteers: e.volunteers,
          sponsors: e.sponsors.map((s, i) => ({ id: `sp-${i + 1}`, name: s.name, tier: s.tier, pledgedPaise: s.pledgedRupees * 100,
            receivedPaise: 0, deliverables: s.deliverables, status: s.status })),
          permits: e.permits.map((p, i) => ({ id: `pm-${i + 1}`, authority: p.authority, kind: p.kind,
            applyBy: addDays(mainDate, p.applyByOffsetDays), status: "not_started" as const, feePaise: p.feeRupees * 100, referenceNo: "" })) };
      }
    })();

    const dates = subEvents.map(s => s.date).sort();
    const start = setup ? setup.startDate : dates[0]!;
    const lastSub = dates[dates.length - 1]!;
    const end = setup?.endDate && setup.endDate > lastSub ? setup.endDate : lastSub;
    const state = AgentState.parse({
      event: { id: `ev-${slugify(bp.title)}`, title: bp.title, eventType: bp.eventType, city: bp.city, totalBudgetPaise,
        guestCount: bp.guestCount, startDate: start, endDate: end, notes: setup?.note ?? "", ext },
      subEvents: subEvents.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin),
      budgetItems, tasks, timeline,
      ...(setup?.priorities ? { priorities: setup.priorities } : {}),
    });
    const errs = checkInvariants(state);
    if (errs.length) return fail(errs, known);
    const expected = setup ? (() => { const r = resolveSetupBudget(setup); return r.blank.length ? r.totalPaise : r.totalPaise - r.remainderPaise; })() : totalBudgetPaise;
    if (plannedTotal(state) !== expected) return fail(["allocation drift (should be impossible)"], known);
    return { ok: true, state, log: [
      `Created "${bp.title}" (${bp.eventType}, ${bp.city || "city tbd"}) on ${state.event.startDate}${state.event.endDate !== state.event.startDate ? ` → ${state.event.endDate}` : ""}`,
      `${subEvents.length} sub-events · ${budgetItems.length} budget lines summing to ₹${(plannedTotal(state) / 100).toLocaleString("en-IN")} exactly${plannedTotal(state) < totalBudgetPaise ? ` (₹${((totalBudgetPaise - plannedTotal(state)) / 100).toLocaleString("en-IN")} left unallocated)` : ""} · ${tasks.length} tasks`,
    ] };
  } catch (e) {
    if (e instanceof PlanError) return fail([e.message], bp.subEvents.map(s => slugify(s.name)));
    throw e;
  }
}

const VENUE_TASK = /\b(book|confirm|reserve|finali[sz]e)\b.*\b(venue|hall|church|gurdwara|grounds|lawn|banquet)\b/i;
const AFTER_VENUE = /cater|decor|invit|florist|menu|mandap|tent|pandal|stage|seating|head ?count|photo booth/i;
const PERMIT_TASK = /\b(apply|get|obtain)\b.*\b(permission|permit|noc)\b/i;
const AFTER_PERMIT = /stall|roster|procession|visarjan|sound/i;
/** Venue booking comes before decor, catering and invitations; permissions before stalls and the procession. In place. */
export function inferDependencies(tasks: { id: string; title: string; dependsOn: string[] }[]) {
  const venue = tasks.find(t => VENUE_TASK.test(t.title));
  const permit = tasks.find(t => PERMIT_TASK.test(t.title));
  for (const t of tasks) {
    const deps = new Set(t.dependsOn);
    if (venue && t.id !== venue.id && AFTER_VENUE.test(t.title)) deps.add(venue.id);
    if (permit && t.id !== permit.id && AFTER_PERMIT.test(t.title)) deps.add(permit.id);
    t.dependsOn = [...deps];
  }
}
