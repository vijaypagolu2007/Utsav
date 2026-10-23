// First-run setup: what the organiser tells us (type, names, city, dates, guests, total, a note, and their own budget
// choices per category), the category suggestions we show as hints, the budget resolution rules, and the deterministic
// offline blueprint. The user's amounts are hard constraints: initializeEventPlan enforces them after any AI draft.
import { z } from "zod";
import { BudgetItem, EventType, ExperienceLevel, IsoDate, type BudgetCategory } from "./schema";
import { addDays, allocateRupeeGrain, daysBetween, MAX_DIRECT_AMOUNT_PAISE, PlanError, rupees, weekdayOf } from "./commands";
import type { InitializeEventPlanInput } from "./blueprint";

const Category = BudgetItem.shape.category;
export const MAX_SETUP_RUPEES = MAX_DIRECT_AMOUNT_PAISE / 100;
export const MAX_SETUP_DAYS = 11;

// ---------------------------------------------------------------- styles (tradition / venue / festival)
export const STYLES = {
  wedding: [
    { id: "telugu-hindu", label: "Telugu Hindu" }, { id: "tamil-hindu", label: "Tamil Hindu" }, { id: "north-hindu", label: "North Indian Hindu" },
    { id: "christian", label: "Christian" }, { id: "muslim", label: "Muslim" }, { id: "sikh", label: "Sikh" },
    { id: "civil", label: "Registered (civil) with a reception" }, { id: "other", label: "Other or mixed" },
  ],
  birthday: [
    { id: "kid-home", label: "Kid's party at home" }, { id: "kid-venue", label: "Kid's party at a venue" },
    { id: "adult-home", label: "Grown-up party at home" }, { id: "adult-venue", label: "Grown-up party at a venue" },
  ],
  community: [
    { id: "ganesh", label: "Ganesh Chaturthi pandal" }, { id: "navratri", label: "Navratri / garba nights" }, { id: "diwali", label: "Diwali mela" },
    { id: "cultural", label: "Cultural fest" }, { id: "other", label: "Other community event" },
  ],
} as const satisfies Record<z.infer<typeof EventType>, readonly { id: string; label: string }[]>;
export type SetupEventType = z.infer<typeof EventType>;
export const defaultStyle = (t: SetupEventType) => STYLES[t][0].id;
export const styleLabel = (t: SetupEventType, id: string) => STYLES[t].find(s => s.id === id)?.label ?? id;

// ---------------------------------------------------------------- the setup form
export const SetupCategory = z.object({
  category: Category,
  include: z.boolean(),
  /** Exact whole rupees the user typed. Takes precedence over percentBps. */
  amountRupees: z.number().int().min(0).max(MAX_SETUP_RUPEES).nullable().default(null),
  /** Or a share of the total, in basis points (12.5% = 1250). Code turns it into paise. */
  percentBps: z.number().int().min(0).max(10_000).nullable().default(null),
  /** "I've already booked this": the line is committed at that amount and locked. Needs an amount. */
  booked: z.boolean().default(false),
});
export type SetupCategory = z.infer<typeof SetupCategory>;

export const SetupInput = z.object({
  eventType: EventType,
  style: z.string().max(40).default(""),
  title: z.string().trim().max(120).default(""),
  partners: z.tuple([z.string().trim().max(60), z.string().trim().max(60)]).optional(),
  honoree: z.string().trim().max(60).optional(),
  turningAge: z.number().int().min(1).max(120).nullable().optional(),
  organizer: z.string().trim().max(80).optional(),
  city: z.string().trim().min(1, "Enter a city").max(80),
  startDate: IsoDate,
  endDate: IsoDate.optional(),
  guestCount: z.number().int().min(1, "Enter how many guests").max(100_000),
  totalBudgetRupees: z.number().int().min(1_000, "Enter a total of at least ₹1,000").max(MAX_SETUP_RUPEES),
  note: z.string().trim().max(1000).default(""),
  categories: z.array(SetupCategory).min(1).max(13),
  /** The organiser's "today": tasks the draft would already have missed are moved to today instead (code, not the LLM). */
  today: IsoDate.optional(),
  /** v6: what matters most. Must-protect and cut-first categories (the rest are flexible) and the experience level. */
  priorities: z.object({ protect: z.array(Category).max(13).default([]), cutFirst: z.array(Category).max(13).default([]), level: ExperienceLevel.default("balanced") }).optional(),
}).superRefine((s, ctx) => {
  if (s.endDate && s.endDate < s.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "The last day can't be before the first day" });
  if (s.endDate && daysBetween(s.startDate, s.endDate) + 1 > MAX_SETUP_DAYS) ctx.addIssue({ code: "custom", path: ["endDate"], message: `Keep it to ${MAX_SETUP_DAYS} days or fewer` });
  if (addDays(s.startDate, 0) !== s.startDate) ctx.addIssue({ code: "custom", path: ["startDate"], message: "Not a real date" });
  if (!(STYLES[s.eventType] as readonly { id: string }[]).some(x => x.id === s.style) && s.style !== "") ctx.addIssue({ code: "custom", path: ["style"], message: "Unknown style" });
  const cats = s.categories.map(c => c.category);
  if (new Set(cats).size !== cats.length) ctx.addIssue({ code: "custom", path: ["categories"], message: "Each category once" });
  if (!s.categories.some(c => c.include)) ctx.addIssue({ code: "custom", path: ["categories"], message: "Turn on at least one category" });
  if (s.priorities && s.priorities.protect.some(c => s.priorities!.cutFirst.includes(c))) ctx.addIssue({ code: "custom", path: ["priorities"], message: "A category can't be both protected and cut first" });
});
export type SetupInput = z.infer<typeof SetupInput>;
export type SetupInputRaw = z.input<typeof SetupInput>;

// ---------------------------------------------------------------- category suggestions (the greyed hints)
export type SuggestedCategory = { category: BudgetCategory; label: string; weightBps: number };
const W = (category: BudgetCategory, label: string, weightBps: number): SuggestedCategory => ({ category, label, weightBps });

/** Our suggested categories and shares for an event type and style. Code-owned; the AI never sets amounts. */
export function suggestedCategories(type: SetupEventType, style: string): SuggestedCategory[] {
  if (type === "wedding") {
    if (style === "civil") return [W("venue", "Reception venue", 2000), W("catering", "Reception dinner", 3500), W("decor", "Reception decor", 1000),
      W("photo_video", "Photographer", 1000), W("attire", "Outfits", 700), W("beauty", "Hair & makeup", 300), W("stationery", "Invitations", 150),
      W("gifts", "Return gifts", 300), W("music", "Music & sound", 300), W("misc", "Contingency", 750)];
    return [W("venue", "Wedding venue", 1600), W("catering", "Catering", 3000), W("decor", style === "christian" ? "Church & reception florals" : "Mandap & decor", 1800),
      W("photo_video", "Photo & video", 900), W("music", style === "telugu-hindu" || style === "tamil-hindu" ? "Nadaswaram & sound" : style === "sikh" || style === "north-hindu" ? "Dhol, DJ & sound" : "Music & sound", 500),
      W("attire", "Bride & groom attire", 700), W("beauty", "Bridal makeup", 300), W("stationery", "Invitations", 150), W("gifts", "Return gifts", 250),
      W("logistics", "Guest transport", 300), W("misc", "Contingency", 500)];
  }
  if (type === "birthday") {
    switch (style) {
      case "kid-home": return [W("catering", "Cake & snacks", 3000), W("decor", "Balloons & theme decor", 2000), W("entertainment", "Magician or games host", 2500),
        W("gifts", "Return gifts", 1500), W("photo_video", "Photos", 700), W("misc", "Contingency", 300)];
      case "kid-venue": return [W("venue", "Play area or party hall", 3000), W("catering", "Cake & kids' menu", 2500), W("decor", "Theme decor", 1200),
        W("entertainment", "Magician or games host", 1500), W("gifts", "Return gifts", 1000), W("photo_video", "Photos", 500), W("misc", "Contingency", 300)];
      case "adult-home": return [W("catering", "Food & drinks", 4000), W("decor", "Decor & lighting", 1500), W("music", "Speaker & playlist", 1500),
        W("entertainment", "Games & activities", 1000), W("photo_video", "Photo booth", 800), W("gifts", "Return gifts", 500), W("misc", "Contingency", 700)];
      default: return [W("venue", "Party venue", 3000), W("catering", "Food & drinks", 3000), W("decor", "Theme decor", 1000), W("entertainment", "Games & entertainment", 1000),
        W("music", "DJ & sound", 800), W("photo_video", "Photo booth", 500), W("gifts", "Return gifts", 300), W("logistics", "Cabs home", 200), W("misc", "Contingency", 200)];
    }
  }
  if (style === "ganesh") return [W("decor", "Ganesh idol & pandal decor", 2200), W("logistics", "Pandal, tent & lighting", 2200), W("music", "Sound & dhol-tasha", 1200),
    W("catering", "Prasad & bhog", 1200), W("permits", "Police, municipal & power permissions", 500), W("entertainment", "Cultural evenings", 1000),
    W("stationery", "Banners & flyers", 300), W("photo_video", "Photos & live stream", 300), W("misc", "Security, first aid & contingency", 1100)];
  return [W("venue", "Grounds or hall rental", 1800), W("permits", "Permits & NOC fees", 500), W("decor", style === "diwali" ? "Lights, diyas & rangoli" : "Stage & lighting", 2000),
    W(style === "navratri" ? "music" : "entertainment", style === "navratri" ? "Live garba band & sound" : "Performers & cultural troupes", 1800),
    W("logistics", "Tents, chairs & sanitation", 1400), W("catering", "Volunteer meals", 600), W("stationery", "Banners & signage", 500),
    W("photo_video", "Photos & live stream", 400), W("misc", "Security & first aid", 1000)];
}

/** Setup rows for a type and style: every suggested category, on, blank (to be filled from the remainder). */
export const defaultSetupCategories = (type: SetupEventType, style: string): SetupCategory[] =>
  suggestedCategories(type, style).map(s => ({ category: s.category, include: true, amountRupees: null, percentBps: null, booked: false }));

/** The greyed hint per category: its share of the suggested weights and that share of the total, exact to the paisa. */
export function suggestionHints(type: SetupEventType, style: string, totalRupees: number): Record<string, { pctLabel: string; paise: number }> {
  const s = suggestedCategories(type, style);
  const sum = s.reduce((a, x) => a + x.weightBps, 0);
  const alloc = totalRupees > 0 ? allocateRupeeGrain(totalRupees * 100, s.map(x => ({ id: x.category, w: x.weightBps }))) : new Map<string, number>();
  return Object.fromEntries(s.map(x => [x.category, { pctLabel: `${Math.round((x.weightBps / sum) * 1000) / 10}%`, paise: alloc.get(x.category) ?? 0 }]));
}

// ---------------------------------------------------------------- budget resolution (code, never the LLM)
export type ResolvedBudget = {
  totalPaise: number;
  /** Categories with an amount the user set (exact), and whether it's already booked. */
  fixed: { category: BudgetCategory; paise: number; booked: boolean }[];
  /** Included categories left blank: filled from the remainder. */
  blank: BudgetCategory[];
  excluded: BudgetCategory[];
  /** total − Σ fixed. Spread over `blank`; stays unallocated headroom when nothing is blank. */
  remainderPaise: number;
};

/** A percentage of the total in paise, floored exactly with BigInt. */
const pctOf = (totalPaise: number, bps: number) => Number((BigInt(totalPaise) * BigInt(bps)) / 10_000n);

export function resolveSetupBudget(setup: Pick<SetupInput, "totalBudgetRupees" | "categories">): ResolvedBudget {
  const totalPaise = setup.totalBudgetRupees * 100;
  const fixed: ResolvedBudget["fixed"] = [], blank: BudgetCategory[] = [], excluded: BudgetCategory[] = [];
  for (const c of setup.categories) {
    if (!c.include) { excluded.push(c.category); continue; }
    const paise = c.amountRupees !== null ? c.amountRupees * 100 : c.percentBps !== null ? pctOf(totalPaise, c.percentBps) : null;
    if (paise === null) {
      if (c.booked) throw new PlanError(`Enter the amount you booked for ${c.category.replace("_", " & ")}`);
      blank.push(c.category);
    } else fixed.push({ category: c.category, paise, booked: c.booked });
  }
  const sum = fixed.reduce((a, f) => a + f.paise, 0);
  if (sum > totalPaise) throw new PlanError(`Your amounts add up to ${rupees(sum)}, which is ${rupees(sum - totalPaise)} over the ${rupees(totalPaise)} total`);
  return { totalPaise, fixed, blank, excluded, remainderPaise: totalPaise - sum };
}

export type DraftLine = { category: BudgetCategory; label: string; subEvent?: string; weightBps: number };
export type ConstrainedLine = { category: BudgetCategory; label: string; subEvent?: string; plannedPaise: number; committedPaise: number; locked: boolean };

/**
 * Apply the user's budget choices to drafted lines (from the AI or the offline blueprint). Excluded categories are
 * dropped; a category with an amount gets exactly that amount (split over its drafted lines by weight; a booked one is
 * one committed, locked line); blank categories share the remainder by normalised weights, largest remainder (whole
 * rupees first, then any odd paise), so the total is exact to the paisa.
 */
export function constrainBudgetLines(lines: DraftLine[], setup: Pick<SetupInput, "eventType" | "style" | "totalBudgetRupees" | "categories">): ConstrainedLine[] {
  const r = resolveSetupBudget(setup);
  const sugg = new Map(suggestedCategories(setup.eventType, setup.style).map(s => [s.category, s]));
  const byCat = new Map<BudgetCategory, DraftLine[]>();
  for (const l of lines) if (!r.excluded.includes(l.category)) byCat.set(l.category, [...(byCat.get(l.category) ?? []), l]);
  const linesFor = (cat: BudgetCategory): DraftLine[] => byCat.get(cat) ?? [{ category: cat, label: sugg.get(cat)?.label ?? defaultLabel(cat), weightBps: sugg.get(cat)?.weightBps ?? 500 }];
  const split = (cat: BudgetCategory, paise: number): ConstrainedLine[] => {
    const ls = linesFor(cat);
    const alloc = allocateRupeeGrain(paise, ls.map((l, i) => ({ id: String(i).padStart(3, "0"), w: Math.max(1, l.weightBps) })));
    return ls.map((l, i) => ({ category: cat, label: l.label, ...(l.subEvent ? { subEvent: l.subEvent } : {}), plannedPaise: alloc.get(String(i).padStart(3, "0"))!, committedPaise: 0, locked: false }));
  };
  const out: ConstrainedLine[] = [];
  for (const f of r.fixed) {
    if (f.booked) {
      const ls = linesFor(f.category);
      const first = ls[0]!;
      out.push({ category: f.category, label: ls.length === 1 ? first.label : sugg.get(f.category)?.label ?? defaultLabel(f.category),
        ...(ls.length === 1 && first.subEvent ? { subEvent: first.subEvent } : {}), plannedPaise: f.paise, committedPaise: f.paise, locked: true });
    } else out.push(...split(f.category, f.paise));
  }
  if (r.blank.length) {
    const weights = r.blank.map(cat => ({ id: cat, w: linesFor(cat).reduce((a, l) => a + Math.max(1, l.weightBps), 0) }));
    const alloc = allocateRupeeGrain(r.remainderPaise, weights);
    for (const cat of r.blank) out.push(...split(cat, alloc.get(cat)!));
  }
  // Keep the user's category order.
  const order = new Map(setup.categories.map((c, i) => [c.category, i]));
  return out.map((l, i) => ({ l, i })).sort((a, b) => (order.get(a.l.category) ?? 99) - (order.get(b.l.category) ?? 99) || a.i - b.i).map(x => x.l);
}

const CAT_DEFAULT: Record<BudgetCategory, string> = {
  venue: "Venue", catering: "Catering", decor: "Decor", photo_video: "Photo & video", music: "Music", attire: "Attire", beauty: "Beauty",
  stationery: "Invitations", gifts: "Return gifts", logistics: "Logistics", permits: "Permits", entertainment: "Entertainment", misc: "Contingency",
};
export const defaultLabel = (c: BudgetCategory) => CAT_DEFAULT[c];

// ---------------------------------------------------------------- deterministic offline blueprint
type Sub = { name: string; dayOffset: number; startMin: number; endMin: number; phase: "pre" | "main" | "post"; isMain?: boolean; venue?: string; dressCode?: string };
type Blk = { subEvent: string; label: string; startMin: number; endMin: number; lane?: string; anchored?: boolean };
type Tsk = { title: string; subEvent?: string; dueOffsetDays: number; priority: "low" | "med" | "high" };

/** Number of days in the window: the user's range, or a sensible default for the style. */
export function setupDays(setup: Pick<SetupInput, "eventType" | "style" | "startDate" | "endDate">): number {
  if (setup.endDate) return Math.min(MAX_SETUP_DAYS, daysBetween(setup.startDate, setup.endDate) + 1);
  if (setup.eventType === "community") return setup.style === "ganesh" ? 5 : setup.style === "navratri" ? 9 : 1;
  return 1;
}

function weddingPlan(style: string, days: number): { subs: Sub[]; blocks: Blk[]; tasks: Tsk[]; traditions: string[] } {
  const last = days - 1;
  const pre = (name: string, day: number, s: number, e: number): Sub => ({ name, dayOffset: Math.max(0, day), startMin: s, endMin: e, phase: "pre" });
  const main = (name: string, s: number, e: number, day = last): Sub => ({ name, dayOffset: day, startMin: s, endMin: e, phase: "main", isMain: true });
  const post = (name: string, day: number, s: number, e: number): Sub => ({ name, dayOffset: day, startMin: s, endMin: e, phase: "post" });
  const common: Tsk[] = [
    { title: "Book venue & pay deposit", dueOffsetDays: -150, priority: "high" }, { title: "Shortlist caterers & book a tasting", dueOffsetDays: -100, priority: "high" },
    { title: "Book photographer", dueOffsetDays: -90, priority: "med" }, { title: "Send invitations", dueOffsetDays: -45, priority: "med" },
    { title: "Confirm final head count with caterer", dueOffsetDays: -7, priority: "high" },
  ];
  switch (style) {
    case "christian": {
      const subs = [...(days >= 2 ? [pre("Rehearsal dinner", last - 1, 1140, 1320)] : []), main("Church ceremony", 600, 720), post("Reception", last, 1110, 1350)];
      return { subs, traditions: ["christian"], tasks: [...common, { title: "Book the church and publish the banns", subEvent: "Church ceremony", dueOffsetDays: -60, priority: "high" }],
        blocks: [{ subEvent: "Church ceremony", label: "Processional", startMin: 600, endMin: 615 }, { subEvent: "Church ceremony", label: "Vows & rings", startMin: 615, endMin: 660, anchored: true },
          { subEvent: "Reception", label: "First dance", startMin: 1170, endMin: 1185 }, { subEvent: "Reception", label: "Dinner", lane: "catering", startMin: 1200, endMin: 1320 }] };
    }
    case "muslim": {
      const walimaDay = days >= 3 ? last : last;
      const nikahDay = days >= 3 ? last - 1 : last;
      const subs = [...(days >= 2 ? [pre("Mehendi", 0, 1080, 1320)] : []), main("Nikah", 660, 780, nikahDay), post("Walima", walimaDay, 1170, 1380)];
      return { subs, traditions: ["muslim"], tasks: [...common, { title: "Confirm the qazi and witnesses for the Nikah", subEvent: "Nikah", dueOffsetDays: -30, priority: "high" }],
        blocks: [{ subEvent: "Nikah", label: "Nikah", startMin: 660, endMin: 720, anchored: true }, { subEvent: "Walima", label: "Walima dinner", lane: "catering", startMin: 1200, endMin: 1350 }] };
    }
    case "sikh": {
      const subs = [...(days >= 2 ? [pre("Mehendi & Sangeet", last - 1, 1080, 1380)] : []), main("Anand Karaj", 540, 780), post("Reception", last, 1140, 1380)];
      return { subs, traditions: ["sikh"], tasks: [...common, { title: "Book the gurdwara for the Anand Karaj", subEvent: "Anand Karaj", dueOffsetDays: -60, priority: "high" }],
        blocks: [{ subEvent: "Anand Karaj", label: "Laavan", startMin: 600, endMin: 660, anchored: true }, { subEvent: "Anand Karaj", label: "Langar", lane: "catering", startMin: 690, endMin: 780 }] };
    }
    case "civil": {
      const subs = [main("Registration", 660, 720), post("Reception dinner", last, 1140, 1350)];
      return { subs, traditions: ["civil"], tasks: [...common, { title: "File the marriage registration notice", subEvent: "Registration", dueOffsetDays: -35, priority: "high" }],
        blocks: [{ subEvent: "Registration", label: "Signing", startMin: 660, endMin: 700, anchored: true }, { subEvent: "Reception dinner", label: "Dinner", lane: "catering", startMin: 1200, endMin: 1320 }] };
    }
    case "north-hindu": {
      const subs = days === 1 ? [main("Wedding & pheras", 1080, 1439)]
        : [pre("Haldi", 0, 600, 780), pre("Mehendi", 0, 990, 1200), ...(days >= 3 ? [pre("Sangeet", last - 1, 1140, 1380)] : []), main("Wedding & pheras", 1080, 1439)];
      return { subs, traditions: ["hindu", "north-indian"], tasks: [...common, { title: "Book the pandit and fix the phera muhurat", subEvent: "Wedding & pheras", dueOffsetDays: -120, priority: "high" }],
        blocks: [{ subEvent: "Wedding & pheras", label: "Baraat", startMin: 1080, endMin: 1170 }, { subEvent: "Wedding & pheras", label: "Varmala", startMin: 1170, endMin: 1200 },
          { subEvent: "Wedding & pheras", label: "Pheras", startMin: 1320, endMin: 1410, anchored: true }] };
    }
    case "tamil-hindu": {
      const subs = [...(days >= 2 ? [pre("Nichayathartham", last - 1, 1080, 1260)] : []), main("Muhurtham", 420, 660), post("Reception", last, 1110, 1350)];
      return { subs, traditions: ["hindu", "tamil"], tasks: [...common, { title: "Book the vadhyar and fix the muhurtham", subEvent: "Muhurtham", dueOffsetDays: -120, priority: "high" }],
        blocks: [{ subEvent: "Muhurtham", label: "Kasi yatra", startMin: 420, endMin: 450 }, { subEvent: "Muhurtham", label: "Mangalya dharanam", startMin: 480, endMin: 510, anchored: true },
          { subEvent: "Muhurtham", label: "Wedding lunch", lane: "catering", startMin: 630, endMin: 660 }] };
    }
    case "other": {
      const subs = [...(days >= 2 ? [pre("Pre-wedding celebration", last - 1, 1080, 1320)] : []), main("Wedding ceremony", 600, 780), post("Reception", last, 1140, 1380)];
      return { subs, traditions: [], tasks: [...common, { title: "Confirm the officiant", subEvent: "Wedding ceremony", dueOffsetDays: -60, priority: "high" }],
        blocks: [{ subEvent: "Wedding ceremony", label: "Ceremony", startMin: 630, endMin: 690, anchored: true }, { subEvent: "Reception", label: "Dinner", lane: "catering", startMin: 1200, endMin: 1320 }] };
    }
    default: { // telugu-hindu
      const subs = days === 1 ? [main("Muhurtham", 420, 720), post("Reception", last, 1140, 1380)]
        : [pre("Haldi", 0, 600, 780), pre("Mehendi", 0, 990, 1200), ...(days >= 3 ? [pre("Sangeet", last - 1, 1140, 1380)] : []), main("Muhurtham", 420, 720), post("Reception", last, 1140, 1380)];
      return { subs, traditions: ["telugu", "hindu"], tasks: [...common, { title: "Book the purohit and fix the muhurtham", subEvent: "Muhurtham", dueOffsetDays: -120, priority: "high" },
          ...(days > 1 ? [{ title: "Confirm Haldi florist", subEvent: "Haldi", dueOffsetDays: -14, priority: "med" as const }] : [])],
        blocks: [{ subEvent: "Muhurtham", label: "Edurukolu & welcome", startMin: 420, endMin: 470 }, { subEvent: "Muhurtham", label: "Jeelakarra bellam", startMin: 470, endMin: 500, anchored: true },
          { subEvent: "Muhurtham", label: "Wedding lunch", lane: "catering", startMin: 630, endMin: 720 }] };
    }
  }
}

/** A deterministic, sensible plan for a setup: sub-events, tasks, a run-of-show and lines (weights only). */
export function blueprintFromSetup(raw: SetupInputRaw): InitializeEventPlanInput {
  const s = SetupInput.parse(raw);
  const style = s.style || defaultStyle(s.eventType);
  const days = setupDays({ ...s, style });
  const lines = suggestedCategories(s.eventType, style);
  const base = { eventType: s.eventType, city: s.city, startDate: s.startDate, totalBudgetRupees: s.totalBudgetRupees, guestCount: s.guestCount };
  if (s.eventType === "wedding") {
    const w = weddingPlan(style, days);
    const mainName = w.subs.find(x => x.isMain)!.name;
    const partners: [string, string] = [s.partners?.[0] || "Partner 1", s.partners?.[1] || "Partner 2"];
    return { ...base, title: s.title || `${partners[0]} & ${partners[1]}'s Wedding`, subEvents: w.subs,
      budgetLines: lines.map(l => ({ ...l, ...(["venue", "catering", "decor"].includes(l.category) ? { subEvent: mainName } : {}) })),
      tasks: w.tasks.map(t => ({ ...t, subEvent: t.subEvent ?? mainName })), timeline: w.blocks, ext: { type: "wedding", partners, traditions: w.traditions } };
  }
  if (s.eventType === "birthday") {
    const kid = style.startsWith("kid");
    const home = style.endsWith("home");
    const age = s.turningAge ?? null;
    const honoree = s.honoree || "the birthday star";
    const partyStart = kid ? 960 : 1140, partyEnd = kid ? 1140 : 1410;
    const theme = s.note.match(/([a-z][a-z -]{2,30}?)\s*(?:-|\s)?themed?\b/i)?.[1]?.trim().replace(/\b\w/g, c => c.toUpperCase()) ?? "";
    return { ...base, title: s.title || `${honoree}'s ${age ? `${age}${ordinal(age)} ` : ""}Birthday`,
      subEvents: [
        { name: home ? "Home setup" : "Venue setup", dayOffset: 0, startMin: partyStart - 180, endMin: partyStart - 30, phase: "pre" },
        { name: "Party", dayOffset: 0, startMin: partyStart, endMin: partyEnd, phase: "main", isMain: true, venue: home ? "Home" : "" },
      ],
      budgetLines: lines.map(l => ({ ...l, subEvent: l.category === "decor" ? (home ? "Home setup" : "Venue setup") : "Party" })),
      tasks: [
        { title: "Send invites", subEvent: "Party", dueOffsetDays: kid ? -14 : -21, priority: "high" },
        ...(home ? [] : [{ title: "Book the venue", subEvent: "Party", dueOffsetDays: -30, priority: "high" as const }]),
        { title: kid ? "Book the magician or games host" : "Plan games and music", subEvent: "Party", dueOffsetDays: -14, priority: "med" },
        { title: "Order the cake", subEvent: "Party", dueOffsetDays: -5, priority: "med" },
        { title: "Buy return gifts", subEvent: "Party", dueOffsetDays: -7, priority: "med" },
        ...(kid ? [{ title: "Ask parents about food allergies", subEvent: "Party", dueOffsetDays: -7, priority: "high" as const }] : []),
      ],
      timeline: kid
        ? [{ subEvent: "Party", label: "Welcome & colouring corner", startMin: partyStart, endMin: partyStart + 30 },
           { subEvent: "Party", label: "Magic show", startMin: partyStart + 30, endMin: partyStart + 75 },
           { subEvent: "Party", label: "Cake cutting", startMin: partyStart + 90, endMin: partyStart + 105, anchored: true },
           { subEvent: "Party", label: "Snacks & return gifts", lane: "catering", startMin: partyStart + 105, endMin: partyEnd }]
        : [{ subEvent: "Party", label: "Welcome drinks", startMin: partyStart, endMin: partyStart + 60 },
           { subEvent: "Party", label: "Games", startMin: partyStart + 60, endMin: partyStart + 120 },
           { subEvent: "Party", label: "Cake & toast", startMin: partyStart + 150, endMin: partyStart + 170, anchored: true },
           { subEvent: "Party", label: "Dinner & dancing", startMin: partyStart + 180, endMin: partyEnd }],
      ext: { type: "birthday", honoree, turningAge: age, theme,
        wishlist: kid
          ? [{ item: "Building blocks set", approxRupees: 2500, priority: "high" }, { item: "Picture story books", approxRupees: 800, priority: "med" }, { item: "Art & craft kit", approxRupees: 1200, priority: "med" }]
          : [{ item: "Experience voucher", approxRupees: 5000, priority: "high" }, { item: "Books", approxRupees: 2000, priority: "med" }],
        activities: kid
          ? [{ name: "Magic show", ageRange: [3, 12], durationMin: 45, supplies: [] }, { name: "Treasure hunt", ageRange: [4, 12], durationMin: 30, supplies: ["Picture clues", "Small prizes"] },
             { name: "Cake cutting", durationMin: 15, supplies: ["Cake", "Candles", "Knife"] }]
          : [{ name: "Party games", durationMin: 60, supplies: ["Props"] }, { name: "Cake & toast", durationMin: 20, supplies: ["Cake", "Candles"] }] } };
  }
  // community
  const org = s.organizer || "Residents' Welfare Association";
  const permits = [
    { authority: "Police", kind: style === "ganesh" ? "Pandal & procession permission" : "Public gathering NOC", applyByOffsetDays: -21, feeRupees: 0 },
    { authority: "Municipal corporation", kind: "Event permission", applyByOffsetDays: -21, feeRupees: 5000 },
    { authority: "Electricity board", kind: "Temporary power connection", applyByOffsetDays: -14, feeRupees: 3000 },
    ...(style === "ganesh" || style === "navratri" ? [] : [{ authority: "Fire services", kind: "Fire NOC", applyByOffsetDays: -14, feeRupees: 5000 }]),
  ];
  const ext = { type: "community" as const, organizer: org, expectedFootfall: s.guestCount, volunteers: Math.max(10, Math.round(s.guestCount / 50)), sponsors: [], permits };
  if (style === "ganesh" || style === "navratri") {
    const g = style === "ganesh";
    const n = Math.max(1, days);
    const open = g ? "Ganesh sthapana" : "Ghatasthapana & opening aarti";
    const close = g ? "Visarjan" : "Dussehra closing";
    const subs: Sub[] = [
      { name: g ? "Pandal setup & briefing" : "Venue setup & briefing", dayOffset: 0, startMin: 360, endMin: 510, phase: "pre" },
      { name: open, dayOffset: 0, startMin: 540, endMin: 720, phase: "main", isMain: true },
    ];
    for (let d = 1; d < n - 1 && subs.length < 11; d++) subs.push({ name: g ? `Day ${d + 1} aarti & bhajans` : `Night ${d + 1} garba`, dayOffset: d, startMin: g ? 1140 : 1200, endMin: g ? 1260 : 1380, phase: "post" });
    if (n >= 2) subs.push({ name: close, dayOffset: n - 1, startMin: g ? 900 : 1080, endMin: g ? 1260 : 1320, phase: "post" });
    else subs.push({ name: close, dayOffset: 0, startMin: g ? 1020 : 1080, endMin: g ? 1260 : 1320, phase: "post" });
    return { ...base, title: s.title || (g ? `${s.city} Ganesh Utsav` : `${s.city} Navratri Utsav`), subEvents: subs,
      budgetLines: lines.map(l => ({ ...l, subEvent: open })),
      tasks: [
        ...(g ? [{ title: "Book the eco-friendly idol", subEvent: open, dueOffsetDays: -45, priority: "high" as const }] : [{ title: "Book the garba band", subEvent: open, dueOffsetDays: -45, priority: "high" as const }]),
        { title: "Apply for police and municipal permissions", subEvent: open, dueOffsetDays: -30, priority: "high" },
        { title: "Pitch sponsors and collect chanda", subEvent: open, dueOffsetDays: -35, priority: "high" },
        { title: "Publish the daily aarti and volunteer rota", subEvent: open, dueOffsetDays: -7, priority: "med" },
        { title: g ? "Arrange visarjan transport and route" : "Plan the closing night", subEvent: close, dueOffsetDays: -10, priority: "high" },
      ],
      timeline: [{ subEvent: open, label: g ? "Pran pratishtha" : "Ghatasthapana", startMin: 570, endMin: 630, anchored: true }, { subEvent: open, label: "Prasad distribution", lane: "prasad", startMin: 630, endMin: 720 }],
      ext };
  }
  return { ...base, title: s.title || `${s.city} ${style === "diwali" ? "Diwali Mela" : "Community Fest"}`,
    subEvents: [
      { name: "Volunteer briefing", dayOffset: 0, startMin: 480, endMin: 570, phase: "pre" },
      { name: "Main day", dayOffset: 0, startMin: 600, endMin: 1320, phase: "main", isMain: true },
      ...(days >= 2 ? [{ name: "Cleanup & thank-you", dayOffset: days - 1, startMin: 540, endMin: 720, phase: "post" as const }] : []),
    ],
    budgetLines: lines.map(l => ({ ...l, ...(["venue", "decor", "entertainment", "logistics", "music"].includes(l.category) ? { subEvent: "Main day" } : {}) })),
    tasks: [
      { title: "Apply for municipal permission", subEvent: "Main day", dueOffsetDays: -30, priority: "high" },
      { title: "Pitch sponsors", subEvent: "Main day", dueOffsetDays: -35, priority: "high" },
      { title: "Allot food and craft stalls", subEvent: "Main day", dueOffsetDays: -21, priority: "med" },
      { title: "Publish volunteer roster", subEvent: "Volunteer briefing", dueOffsetDays: -7, priority: "med" },
    ],
    timeline: [{ subEvent: "Main day", label: "Inauguration", startMin: 600, endMin: 660, anchored: true }, { subEvent: "Main day", label: "Cultural performances", startMin: 1050, endMin: 1290 },
      { subEvent: "Main day", label: "Stalls open", lane: "stalls", startMin: 660, endMin: 1320 }],
    ext };
}
const ordinal = (n: number) => (["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) % 10 === 1 ? 0 : n % 10]!);

/** The brief we give Gemini for setup: everything the user said, plus the categories it may use. Amounts stay with code. */
export function setupBrief(s: SetupInput): string {
  const style = s.style || defaultStyle(s.eventType);
  const inc = s.categories.filter(c => c.include).map(c => c.category);
  const names = s.eventType === "wedding" && s.partners ? `Couple: ${s.partners.join(" & ")}.` : s.eventType === "birthday" ? `Honoree: ${s.honoree || "?"}${s.turningAge ? `, turning ${s.turningAge}` : ""}.` : `Organiser: ${s.organizer || "?"}.`;
  return [
    `Create a ${s.eventType} plan with initialize_event_plan.`,
    `Style: ${styleLabel(s.eventType, style)}. ${names} Title: ${s.title || "(choose one)"}.`,
    `City: ${s.city}. Starts ${s.startDate} (${weekdayOf(s.startDate)})${s.endDate ? `, ends ${s.endDate}; keep every sub-event within ${setupDays(s)} day(s)` : ""}. Guests: ${s.guestCount}.`,
    `Total budget: ₹${s.totalBudgetRupees.toLocaleString("en-IN")} (the app sets every amount; give weightBps only).`,
    `Use ONLY these budget categories: ${inc.join(", ")}. Do not add lines in any other category.`,
    `Anything special: ${s.note || "(nothing)"}.`,
    ...(s.priorities && (s.priorities.protect.length || s.priorities.cutFirst.length) ? [`Priorities: protect ${s.priorities.protect.join(", ") || "-"}; cut first ${s.priorities.cutFirst.join(", ") || "-"}; ${s.priorities.level} experience. Weight protected categories generously.`] : []),
    "Set dependsOn on tasks that need another done first (venue booking before decor, catering and invitations).",
    "Personalise sub-events, tasks and the run-of-show to the tradition, city and note. Use realistic Indian vendors and customs.",
  ].join("\n");
}
