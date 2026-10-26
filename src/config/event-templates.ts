// Event templates: the one registry of starting plans the app offers.
// A template is (1) a seed plan, validated by the same AgentState schema the reducer uses, and (2) a small, closed
// presentation description: which of the supported dashboard sections to show, in what arrangement, and the text
// around them. Configuration chooses among components that already exist; it never contains code, never decides
// permissions (the reducer and the server's guest projection do that), and never bypasses the command engine.
//
// To add a template: add a seed plan (see presets.ts) and one entry to DEFINITIONS below. The registry is validated
// at module load, so an invalid entry (unknown section, section that needs another event type, unknown text token,
// duplicate id, seed of the wrong event type) fails the build and the tests rather than a user's session.
import { z } from "zod";
import { AgentState, EventType } from "../schema";
import { inrShort } from "../budget-a11y";
import { arcadeBirthday, culturalFest, royalWedding } from "../presets";

// ---------------------------------------------------------------- sections
/**
 * Every dashboard section a template may place, and the event types whose data it reads.
 * "any" sections use only the common plan shape (guests, sub-events) and work for every event type.
 * The React components for these ids live in components/ArchetypeCard.tsx and components/GuestMicrosite.tsx;
 * adding a new id here without its component is a type error there.
 */
export const ORGANIZER_SECTIONS = {
  "rsvp-matrix": "any",
  "couple-profile": ["wedding"],
  "diet-summary": "any",
  "wishlist-manager": ["birthday", "wedding"],
  "activity-run-sheet": ["birthday"],
  "sponsor-pipeline": ["community"],
  "permit-tracker": ["community"],
} as const satisfies Record<string, "any" | readonly EventType[]>;

export const GUEST_SECTIONS = {
  "guest-rsvp": "any",
  "guest-wishlist": ["birthday", "wedding"],
  "community-signup": ["community"],
} as const satisfies Record<string, "any" | readonly EventType[]>;

export type OrganizerSectionId = keyof typeof ORGANIZER_SECTIONS;
export type GuestSectionId = keyof typeof GUEST_SECTIONS;
const OrganizerSection = z.enum(Object.keys(ORGANIZER_SECTIONS) as [OrganizerSectionId, ...OrganizerSectionId[]]);
const GuestSection = z.enum(Object.keys(GUEST_SECTIONS) as [GuestSectionId, ...GuestSectionId[]]);

const supports = (req: "any" | readonly EventType[], t: EventType) => req === "any" || req.includes(t);

// ---------------------------------------------------------------- text with tokens
/**
 * Headings and taglines may reference plan fields as {token}. A [bracketed] segment is dropped when any token inside
 * it is empty, so "{honoree}[ turns {turningAge}]" reads "Aarav" when no age is set. Plain substitution only.
 */
export const TEXT_TOKENS = ["title", "city", "partners", "honoree", "turningAge", "theme", "organizer"] as const;
export type TextToken = (typeof TEXT_TOKENS)[number];
const TOKEN_RE = /\{([a-zA-Z]+)\}/g;
const TokenText = z.string().max(160).refine(s => [...s.matchAll(TOKEN_RE)].every(m => (TEXT_TOKENS as readonly string[]).includes(m[1]!)), {
  message: `unknown {token}; allowed: ${TEXT_TOKENS.join(", ")}`,
});

/** Values for the text tokens, read from the plan. The one place that knows which event type owns which field. */
export function templateTokens(plan: AgentState): Record<TextToken, string> {
  const x = plan.event.ext;
  return {
    title: plan.event.title,
    city: plan.event.city,
    partners: x.type === "wedding" && x.partners.some(Boolean) ? x.partners.join(" & ") : "",
    honoree: x.type === "birthday" ? x.honoree : "",
    turningAge: x.type === "birthday" && x.turningAge ? String(x.turningAge) : "",
    theme: x.type === "birthday" ? x.theme : "",
    organizer: x.type === "community" ? x.organizer : "",
  };
}

export function formatTokens(text: string, tokens: Readonly<Record<string, string>>): string {
  const fill = (s: string) => s.replace(TOKEN_RE, (_, k: string) => tokens[k] ?? "");
  return fill(text.replace(/\[([^\]]*)\]/g, (_, seg: string) =>
    [...seg.matchAll(TOKEN_RE)].every(m => (tokens[m[1]!] ?? "") !== "") ? seg : ""));
}

// ---------------------------------------------------------------- template schema
export const TemplateIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens").max(48);

const OrganizerLayout = z.strictObject({
  /** Title of the event-type card. */
  heading: TokenText.pipe(z.string().min(1)),
  icon: z.enum(["heart", "cake", "megaphone"]),
  /** "main-aside": a wide main column and a narrow side column. "two-up": two equal columns. */
  arrangement: z.enum(["main-aside", "two-up"]),
  /** One or two columns, each a stack of sections. */
  columns: z.array(z.array(OrganizerSection).min(1)).min(1).max(2),
});

const GuestLayout = z.strictObject({
  /** Small caps line above the event title on the guest microsite. */
  kicker: z.string().min(1).max(60),
  /** Line under the dates; hidden when it formats to an empty string. */
  tagline: TokenText,
  /** Cards in the side column next to the itinerary, then full-width cards under it. */
  aside: z.array(GuestSection),
  footer: z.array(GuestSection),
});

export const EventTemplate = z.strictObject({
  id: TemplateIdSchema,
  /** Short display name ("Royal Wedding"); the event switcher adds the budget. */
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  eventType: EventType,
  /** Badge colour for this template's event type. */
  accent: z.enum(["rose", "violet", "sky", "amber", "emerald", "indigo"]),
  seed: AgentState,
  layout: OrganizerLayout,
  guest: GuestLayout,
}).superRefine((t, ctx) => {
  if (t.seed.event.eventType !== t.eventType)
    ctx.addIssue({ code: "custom", path: ["seed", "event", "eventType"], message: `seed is a ${t.seed.event.eventType} plan but the template is ${t.eventType}` });
  t.layout.columns.forEach((col, c) => col.forEach((s, i) => {
    if (!supports(ORGANIZER_SECTIONS[s], t.eventType)) ctx.addIssue({ code: "custom", path: ["layout", "columns", c, i], message: `section "${s}" needs ${String(ORGANIZER_SECTIONS[s])}, not ${t.eventType}` });
  }));
  for (const key of ["aside", "footer"] as const) t.guest[key].forEach((s, i) => {
    if (!supports(GUEST_SECTIONS[s], t.eventType)) ctx.addIssue({ code: "custom", path: ["guest", key, i], message: `section "${s}" needs ${String(GUEST_SECTIONS[s])}, not ${t.eventType}` });
  });
});
export type EventTemplate = z.infer<typeof EventTemplate>;

export const TemplateRegistry = z.array(EventTemplate).min(1).superRefine((list, ctx) => {
  const ids = new Set<string>();
  list.forEach((t, i) => {
    if (ids.has(t.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate template id "${t.id}"` });
    ids.add(t.id);
  });
  // Every event type needs a home: an AI blueprint of any type has to land in some template's slot.
  for (const type of EventType.options)
    if (!list.some(t => t.eventType === type)) ctx.addIssue({ code: "custom", path: [], message: `no template for event type "${type}"` });
});

// ---------------------------------------------------------------- the registry
const WEDDING_LAYOUT = {
  heading: "Wedding · RSVP Matrix & Traditions", icon: "heart", arrangement: "main-aside",
  columns: [["rsvp-matrix"], ["couple-profile", "diet-summary", "wishlist-manager"]],
} as const;
const BIRTHDAY_LAYOUT = {
  heading: "Birthday · {honoree}[ turns {turningAge}] · {theme}", icon: "cake", arrangement: "two-up",
  columns: [["wishlist-manager"], ["activity-run-sheet"]],
} as const;
const COMMUNITY_LAYOUT = {
  heading: "Community · Sponsors & Permits", icon: "megaphone", arrangement: "two-up",
  columns: [["sponsor-pipeline"], ["permit-tracker"]],
} as const;

/**
 * The ids "wedding", "birthday" and "community" predate the registry: they are the keys organizer plans have always
 * been saved under in localStorage (and shared-link records under), so they must never change. New templates pick
 * any new id.
 */
const DEFINITIONS = [
  {
    id: "wedding", name: "Royal Wedding", eventType: "wedding", accent: "rose",
    description: "Five-day Telugu wedding in Hyderabad: Haldi to Reception, 300 guests, an RSVP matrix and vendor deposits.",
    seed: royalWedding, layout: WEDDING_LAYOUT,
    guest: { kicker: "You're invited to celebrate", tagline: "[{partners}]", aside: ["guest-rsvp", "guest-wishlist"], footer: [] },
  },
  {
    id: "birthday", name: "30th Arcade Birthday", eventType: "birthday", accent: "violet",
    description: "Retro arcade 30th with a gift wishlist guests can claim and a timed party activity run-sheet.",
    seed: arcadeBirthday, layout: BIRTHDAY_LAYOUT,
    guest: { kicker: "Party time", tagline: "{honoree}[ turns {turningAge}] · {theme}", aside: ["guest-rsvp", "guest-wishlist"], footer: [] },
  },
  {
    id: "community", name: "Community Cultural Fest", eventType: "community", accent: "sky",
    description: "Three-day neighbourhood cultural fest with a sponsor pipeline, municipal permits and volunteer sign-ups.",
    seed: culturalFest, layout: COMMUNITY_LAYOUT,
    guest: { kicker: "Join the community", tagline: "Hosted by {organizer}", aside: ["guest-rsvp"], footer: ["community-signup"] },
  },
] as const;

export type TemplateId = (typeof DEFINITIONS)[number]["id"];
/** Raw definitions, for tests and the API's validation path. */
export const TEMPLATE_DEFINITIONS: readonly unknown[] = DEFINITIONS;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

export type RegistryResult = { ok: true; templates: readonly EventTemplate[] } | { ok: false; issues: string[] };
/** Validate a registry without throwing (used by the API route and tests). Parsing copies, so the input is never shared. */
export function parseTemplateRegistry(input: unknown): RegistryResult {
  const r = TemplateRegistry.safeParse(input);
  if (!r.success) return { ok: false, issues: r.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  return { ok: true, templates: deepFreeze(r.data) };
}

function loadRegistry(): readonly EventTemplate[] {
  const r = parseTemplateRegistry(DEFINITIONS);
  if (!r.ok) throw new Error(`Invalid event template registry:\n  ${r.issues.join("\n  ")}`);
  return r.templates;
}

/** All templates, validated and deep-frozen, in display order. */
export const TEMPLATES: readonly EventTemplate[] = loadRegistry();
export const DEFAULT_TEMPLATE_ID: TemplateId = DEFINITIONS[0].id;

export const isTemplateId = (s: unknown): s is TemplateId => typeof s === "string" && TEMPLATES.some(t => t.id === s);
export const getTemplate = (id: string): EventTemplate | undefined => TEMPLATES.find(t => t.id === id);
export const requireTemplate = (id: TemplateId): EventTemplate => getTemplate(id)!;
/** The first template of an event type: where an AI blueprint of that type is loaded. */
export const defaultTemplateFor = (type: EventType): EventTemplate => TEMPLATES.find(t => t.eventType === type)!;

/** "Royal Wedding — ₹25L": the switcher label, derived so the budget shown can't drift from the seed. */
export const templateLabel = (t: EventTemplate) => `${t.name} — ${inrShort(t.seed.event.totalBudgetPaise)}`;

/**
 * A fresh, independent plan from a template. The frozen seed is deep-copied and re-validated, so editing the result
 * can never touch the registry or another plan made from the same template. Entity ids (s1, b1, g1…) are scoped to
 * one plan and kept as authored: the offline demo brain, the judge prompts and the tests rely on them, and each
 * template slot holds exactly one plan, so no two live plans share a slot.
 */
export function instantiateTemplate(id: TemplateId): AgentState {
  return AgentState.parse(structuredClone(requireTemplate(id).seed));
}

/** Which template slot a plan belongs in: the active one if the event type matches, else that type's default. */
export function slotFor(activeId: TemplateId, plan: Pick<AgentState, "event">): TemplateId {
  const active = getTemplate(activeId);
  return active && active.eventType === plan.event.eventType ? activeId : (defaultTemplateFor(plan.event.eventType).id as TemplateId);
}

/** Presentation for the plan on screen: the active template's, or the default for the plan's type on mismatch. */
export function presentationFor(activeId: string, plan: Pick<AgentState, "event">): EventTemplate {
  const active = getTemplate(activeId);
  return active && active.eventType === plan.event.eventType ? active : defaultTemplateFor(plan.event.eventType);
}

// ---------------------------------------------------------------- public shape (GET /api/event-templates)
/** What the template API returns. Strict: a field must be added here on purpose before it can leave the server. */
export const PublicTemplate = z.strictObject({
  id: TemplateIdSchema,
  name: z.string(),
  label: z.string(),
  description: z.string(),
  eventType: EventType,
  city: z.string(),
  currency: z.string(),
  totalBudgetPaise: z.number().int().nonnegative(),
  startDate: z.string(),
  endDate: z.string(),
  subEventCount: z.number().int().nonnegative(),
});
export type PublicTemplate = z.infer<typeof PublicTemplate>;

/** Summary only: no guests, households, vendors, contact details, invite codes or the seed itself. */
export const toPublicTemplate = (t: EventTemplate): PublicTemplate => PublicTemplate.parse({
  id: t.id, name: t.name, label: templateLabel(t), description: t.description, eventType: t.eventType,
  city: t.seed.event.city, currency: t.seed.event.currency, totalBudgetPaise: t.seed.event.totalBudgetPaise,
  startDate: t.seed.event.startDate, endDate: t.seed.event.endDate, subEventCount: t.seed.subEvents.length,
});
