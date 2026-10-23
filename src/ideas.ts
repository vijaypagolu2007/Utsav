// Personalised ideas. Gemini (suggest_ideas) or the offline curated bank proposes idea cards; this module is the code
// boundary for them: rupees become integer paise here, ranges are checked, duplicates dropped, and every card is
// compared with what is actually left in its budget category. Cards land on the plan only through applyBatch (add_ideas).
import { z } from "zod";
import { BudgetItem, IdeaKind, type AgentState, type BudgetCategory, type IdeaKind as IdeaKindT } from "./schema";
import { IdeaDraft, MAX_DIRECT_AMOUNT_PAISE, plannedTotal, rupees } from "./commands";

export const IDEA_KINDS = IdeaKind.options;
export const IDEA_KIND_LABEL: Record<IdeaKindT, string> = {
  theme: "Theme", decor: "Decor", menu: "Menu", activity: "Activity", return_gift: "Return gift", invite_text: "Invite text", music: "Music", photo: "Photo",
};
/** The budget category an idea of each kind is paid from when the model (or the bank) doesn't say. */
export const KIND_CATEGORY: Record<IdeaKindT, BudgetCategory | null> = {
  theme: "decor", decor: "decor", menu: "catering", activity: "entertainment", return_gift: "gifts", invite_text: "stationery", music: "music", photo: "photo_video",
};

const MAX_RUPEES = MAX_DIRECT_AMOUNT_PAISE / 100;
/** One card as the model writes it. Rupees, never paise: code converts. */
export const SuggestedIdea = z.object({
  kind: IdeaKind,
  title: z.string().trim().min(1).max(120).describe("Short, specific name, e.g. 'Marigold and mango-leaf toranam entrance'"),
  description: z.string().trim().max(400).default("").describe("One or two lines: what it is and why it suits this event"),
  estLowRupees: z.number().int().min(0).max(MAX_RUPEES).optional().describe("Low end of the realistic total cost in whole rupees (not per guest). Omit when free"),
  estHighRupees: z.number().int().min(0).max(MAX_RUPEES).optional().describe("High end in whole rupees"),
  budgetCategory: BudgetItem.shape.category.optional().describe("The budget category it would be paid from"),
  tags: z.array(z.string().trim().min(1).max(40)).max(6).default([]).describe("e.g. 'eco-friendly', 'telugu', 'kids'"),
});
export const SuggestIdeas = z.object({
  ideas: z.array(SuggestedIdea).min(1).max(8).describe("4 to 8 cards, varied in kind unless the user asked for one kind"),
  focus: z.string().trim().max(120).optional().describe("The user's angle, e.g. 'sangeet', 'eco-friendly', 'under ₹50k'"),
});
export type SuggestIdeasInput = z.input<typeof SuggestIdeas>;
export type IdeaDraftT = z.infer<typeof IdeaDraft>;

/**
 * Money still free per category: its lines' uncommitted envelope plus the plan's unallocated headroom (total − planned).
 * An idea whose low estimate is above this would need money moved from somewhere else.
 */
export function categoryHeadroom(st: AgentState): Record<BudgetCategory, number> {
  const free = Math.max(0, st.event.totalBudgetPaise - plannedTotal(st));
  const out = Object.fromEntries(BudgetItem.shape.category.options.map(c => [c, free])) as Record<BudgetCategory, number>;
  for (const b of st.budgetItems) out[b.category] += Math.max(0, b.plannedPaise - b.committedPaise);
  return out;
}

export type PreparedIdeas = { drafts: IdeaDraftT[]; dropped: { title: string; reason: string }[]; flagged: number };

/** Validate model (or bank) output and turn it into add_ideas drafts. Pure and deterministic. */
export const RefineMode = z.enum(["cheaper", "kid_friendly", "traditional"]);
export type RefineMode = z.infer<typeof RefineMode>;
export const REFINE_LABEL: Record<RefineMode, string> = { cheaper: "Cheaper alternative", kid_friendly: "Make it kid-friendly", traditional: "More traditional" };
export type Refine = { mode: RefineMode; ideaId: string };

export function prepareIdeas(st: AgentState, input: unknown, source: "gemini" | "demo", opts: { refine?: Refine } = {}): { ok: true; value: PreparedIdeas } | { ok: false; reason: string } {
  const from = opts.refine ? st.ideas.find(i => i.id === opts.refine!.ideaId) ?? null : null;
  if (opts.refine && !from) return { ok: false, reason: `No idea ${opts.refine.ideaId} to refine` };
  const p = SuggestIdeas.safeParse(input);
  if (!p.success) return { ok: false, reason: p.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const head = categoryHeadroom(st);
  const seen = new Set(st.ideas.map(i => i.title.trim().toLowerCase()));
  const drafts: IdeaDraftT[] = [], dropped: PreparedIdeas["dropped"] = [];
  let flagged = 0;
  for (const i of p.data.ideas) {
    const key = i.title.trim().toLowerCase();
    if (seen.has(key)) { dropped.push({ title: i.title, reason: "already on the board" }); continue; }
    seen.add(key);
    const given = [i.estLowRupees, i.estHighRupees].filter((x): x is number => x !== undefined);
    const lowR = given.length ? Math.min(...given) : null, highR = given.length ? Math.max(...given) : null;
    const low = lowR === null ? null : lowR * 100, high = highR === null ? null : highR * 100;
    const category = i.budgetCategory ?? KIND_CATEGORY[i.kind];
    if (low !== null && low > st.event.totalBudgetPaise) { dropped.push({ title: i.title, reason: `costs more than the whole ${rupees(st.event.totalBudgetPaise)} budget` }); continue; }
    // "Cheaper alternative" must really be cheaper: code checks, whatever the model said.
    if (opts.refine?.mode === "cheaper" && from?.estLowPaise && low !== null && low >= from.estLowPaise) { dropped.push({ title: i.title, reason: `not cheaper than "${from.title}"` }); continue; }
    const overBudget = low !== null && low > 0 && category !== null && low > head[category];
    if (overBudget) flagged++;
    const refineTag = opts.refine ? ({ cheaper: "cheaper", kid_friendly: "kids", traditional: "traditional" } as const)[opts.refine.mode] : null;
    drafts.push({ kind: i.kind, title: i.title.trim(), description: i.description, estLowPaise: low, estHighPaise: high, category,
      tags: [...new Set([...(refineTag ? [refineTag] : []), ...i.tags.map(t => t.toLowerCase())])].slice(0, 8), source, overBudget, refinedFrom: from?.id ?? null });
  }
  return { ok: true, value: { drafts, dropped, flagged } };
}

/** What the model needs to personalise ideas: type, place, traditions, age, size, diets, money left per category, the note. */
export function ideaContext(st: AgentState): string {
  const e = st.event, x = e.ext;
  const diets = new Map<string, number>();
  for (const g of st.guests) for (const d of g.diet) diets.set(d, (diets.get(d) ?? 0) + 1);
  const head = categoryHeadroom(st);
  const cats = [...new Set(st.budgetItems.map(b => b.category))];
  const lines = [
    `EVENT ${e.eventType} in ${e.city || "an Indian city"}, ${e.startDate}${e.endDate !== e.startDate ? ` to ${e.endDate}` : ""}, about ${e.guestCount || st.guests.length} guests`,
    x.type === "wedding" ? `WEDDING traditions: ${x.traditions.join(", ") || "not stated"}; sub-events: ${st.subEvents.map(s => s.name).join(", ")}`
      : x.type === "birthday" ? `BIRTHDAY for ${x.honoree || "the guest of honour"}${x.turningAge ? `, turning ${x.turningAge}` : ""}; theme ${x.theme || "not set"}`
      : `COMMUNITY event run by ${x.organizer || "a residents' group"}, footfall ~${x.expectedFootfall}; sub-events: ${st.subEvents.map(s => s.name).join(", ")}`,
    `DIETS on the guest list: ${[...diets].map(([d, n]) => `${d} ${n}`).join(", ") || "none recorded"}`,
    `MONEY LEFT per category (uncommitted envelope + unallocated): ${cats.map(c => `${c} ${rupees(head[c])}`).join(", ")}; unallocated ${rupees(Math.max(0, e.totalBudgetPaise - plannedTotal(st)))}`,
    `ORGANISER NOTE: ${e.notes || "(none)"}`,
    `ALREADY ON THE IDEA BOARD (don't repeat): ${st.ideas.filter(i => i.status !== "dismissed").map(i => i.title).slice(0, 30).join("; ") || "(empty)"}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- offline curated bank
type Ctx = { type: AgentState["event"]["eventType"]; kid: boolean; home: boolean; words: string; guests: number };
type BankIdea = {
  kind: IdeaKindT; title: string; description: string; tags: string[];
  /** Whole rupees for the whole event, or per guest (code multiplies by the head count). */
  rupees?: [number, number]; perGuest?: [number, number];
  category?: BudgetCategory;
  types: AgentState["event"]["eventType"][];
  when?: (c: Ctx) => boolean;
};
const has = (c: Ctx, re: RegExp) => re.test(c.words);
const SOUTH = /telugu|tamil|south|kannada|malayal|andhra|telangana|hyderabad|chennai|bengaluru|bangalore|vizag|vijayawada/;
const NORTH = /north|punjab|delhi|lucknow|jaipur|marwari|gujarat|ahmedabad/;
const CHRISTIAN = /christian|church|catholic/;
const MUSLIM = /muslim|nikah|walima|islam/;
const SIKH = /sikh|anand karaj|gurdwara/;
const HINDU_CEREMONY = (c: Ctx) => !has(c, CHRISTIAN) && !has(c, MUSLIM) && !has(c, SIKH);

const BANK: BankIdea[] = [
  // ---- weddings
  { types: ["wedding"], kind: "theme", title: "Temple-town heritage theme", tags: ["traditional", "south", "telugu"], rupees: [150_000, 400_000], when: c => has(c, SOUTH) && HINDU_CEREMONY(c),
    description: "Brass urlis with floating flowers, kolam at every entrance and banana-trunk pillars: rooted, photogenic and easy to source locally." },
  { types: ["wedding"], kind: "decor", title: "Marigold and mango-leaf toranam entrance", tags: ["traditional", "eco-friendly", "telugu"], rupees: [25_000, 60_000], when: HINDU_CEREMONY,
    description: "Fresh toranams over the gate and mandap; auspicious, fragrant and fully compostable after the wedding." },
  { types: ["wedding"], kind: "decor", title: "Pastel floral mandap with jasmine strings", tags: ["mandap", "floral"], rupees: [120_000, 300_000], when: HINDU_CEREMONY,
    description: "Soft peach and ivory blooms with mallepoolu (jasmine) curtains; reads beautifully on camera at a morning muhurtham." },
  { types: ["wedding"], kind: "decor", title: "White-and-sage church florals", tags: ["christian", "floral"], rupees: [40_000, 120_000], when: c => has(c, CHRISTIAN),
    description: "Pew-end posies, an aisle of white roses and eucalyptus, and a simple arch at the altar." },
  { types: ["wedding"], kind: "menu", title: "Banana-leaf wedding lunch", tags: ["south", "telugu", "veg"], perGuest: [450, 900], when: c => has(c, SOUTH) && HINDU_CEREMONY(c),
    description: "Pulihora, gongura pachadi, pappu, sambar, ariselu and bobbatlu served on banana leaves: the meal guests remember." },
  { types: ["wedding"], kind: "menu", title: "Hyderabadi dum biryani and double-ka-meetha", tags: ["hyderabad", "muslim", "non-veg"], perGuest: [500, 900], when: c => has(c, MUSLIM) || (has(c, /hyderabad/) && !has(c, /vegetarian|pure veg|\bveg\b|jain/)),
    description: "Kacchi dum biryani with mirchi ka salan and a veg biryani counter, finished with double-ka-meetha." },
  { types: ["wedding"], kind: "menu", title: "Live dosa and chaat counters for the evening", tags: ["sangeet", "live counter", "veg"], perGuest: [150, 300],
    description: "Two live counters keep queues short and suit Jain and no-onion-garlic guests when you mark those pans separately." },
  { types: ["wedding"], kind: "activity", title: "Ring-in-the-pot game (Ungaram)", tags: ["telugu", "ritual", "fun"], rupees: [2_000, 6_000], when: c => has(c, SOUTH) && HINDU_CEREMONY(c),
    description: "The couple fish for a ring in a pot of milk and flowers: a light-hearted ritual that gets both families cheering." },
  { types: ["wedding"], kind: "activity", title: "Sangeet choreographer for family performances", tags: ["sangeet", "dance"], rupees: [30_000, 80_000], category: "entertainment",
    description: "Three rehearsals and one tight 25-minute family show; cousins love it and it fills the stage without a hired act." },
  { types: ["wedding"], kind: "music", title: "Nadaswaram and thavil for the muhurtham", tags: ["traditional", "south", "telugu"], rupees: [25_000, 60_000], when: c => has(c, SOUTH) && HINDU_CEREMONY(c),
    description: "A live mangala vadyam ensemble for the baraat and the muhurtham moment itself." },
  { types: ["wedding"], kind: "music", title: "Dhol and bhangra troupe for the baraat", tags: ["north", "sikh", "baraat"], rupees: [20_000, 50_000], when: c => has(c, NORTH) || has(c, SIKH),
    description: "Two dholis and four dancers lead the baraat and keep the energy up until the varmala." },
  { types: ["wedding"], kind: "music", title: "Choir and string quartet for the ceremony", tags: ["christian", "live music"], rupees: [30_000, 80_000], when: c => has(c, CHRISTIAN),
    description: "Hymns for the processional and a quartet for the signing and cocktail hour." },
  { types: ["wedding"], kind: "music", title: "Qawwali night for the mehendi", tags: ["muslim", "mehendi", "live music"], rupees: [40_000, 120_000], when: c => has(c, MUSLIM),
    description: "A four-piece qawwali party on floor seating with bolsters makes the mehendi feel like a mehfil." },
  { types: ["wedding"], kind: "return_gift", title: "Brass diya and kumkum box sets", tags: ["traditional", "brass"], perGuest: [150, 350], when: HINDU_CEREMONY,
    description: "Useful, auspicious and long-lasting; pack them per household rather than per guest to save on cost." },
  { types: ["wedding", "birthday", "community"], kind: "return_gift", title: "Seed-paper thank-you cards with a sapling", tags: ["eco-friendly", "budget"], perGuest: [60, 150],
    description: "Plantable thank-you notes with a tulsi or curry-leaf sapling: low waste and genuinely kept." },
  { types: ["wedding"], kind: "invite_text", title: "Bilingual e-invite for WhatsApp", tags: ["invite", "whatsapp"],
    description: "\"With the blessings of our elders, we invite you to celebrate the wedding of our children. Muhurtham details and RSVP link below.\" Add a regional-language line on top." },
  { types: ["wedding"], kind: "photo", title: "Candid coverage plus a drone for the baraat", tags: ["photo", "candid"], rupees: [60_000, 150_000],
    description: "One candid shooter for faces and emotions and a licensed drone operator for the procession and venue reveal." },
  { types: ["wedding", "birthday"], kind: "photo", title: "Instant photo booth with custom frames", tags: ["photo booth", "guests"], rupees: [15_000, 35_000],
    description: "Guests leave with a printed strip and you get a digital album of every face that came." },

  { types: ["wedding"], kind: "theme", title: "Ivory, blush and gold palette", tags: ["theme", "elegant"], rupees: [60_000, 180_000],
    description: "One restrained palette carried through invites, florals, outfits for the family and the cake; it photographs well in any venue." },
  { types: ["wedding"], kind: "music", title: "Live acoustic set for the reception", tags: ["live music", "reception"], rupees: [25_000, 60_000],
    description: "A singer and guitarist for the first hour while guests arrive and eat; keeps conversation possible before the dance floor opens." },

  // ---- birthdays (kids)
  { types: ["birthday"], kind: "theme", title: "Jungle safari party", tags: ["kids", "theme"], rupees: [5_000, 15_000], when: c => c.kid,
    description: "Animal masks at the door, leafy garlands and a cardboard jeep photo spot: cheap, colourful and loved by under-10s." },
  { types: ["birthday"], kind: "decor", title: "Balloon arch in the theme colours", tags: ["kids", "home", "budget"], rupees: [4_000, 12_000], when: c => c.kid,
    description: "One statement arch behind the cake table does more than balloons everywhere; ask for biodegradable latex." },
  { types: ["birthday"], kind: "menu", title: "Mini idlis, pav-bhaji sliders and fruit cups", tags: ["kids", "veg", "finger food"], perGuest: [150, 300], when: c => c.kid,
    description: "Kid-sized portions that aren't fried and won't stain clothes; keep one plate mild and nut-free." },
  { types: ["birthday"], kind: "menu", title: "Two-kilo theme cake with a cupcake tower", tags: ["cake", "kids"], rupees: [2_500, 6_000], category: "catering", when: c => c.kid,
    description: "A small decorated cake for the cutting and cupcakes to serve: no slicing queue and less waste." },
  { types: ["birthday"], kind: "activity", title: "Magician show (45 minutes)", tags: ["kids", "entertainment"], rupees: [6_000, 15_000], when: c => c.kid,
    description: "Book one who involves the birthday child in a trick; it becomes the photo of the day." },
  { types: ["birthday"], kind: "activity", title: "Treasure hunt with picture clues", tags: ["kids", "home", "budget", "diy"], rupees: [500, 2_000], when: c => c.kid,
    description: "Picture clues work for children who can't read yet; hide the return gifts as the treasure." },
  { types: ["birthday"], kind: "activity", title: "Face-painting and glitter-tattoo corner", tags: ["kids"], rupees: [3_000, 8_000], when: c => c.kid,
    description: "One artist handles about 15 children an hour; use skin-safe paints and keep wipes handy." },
  { types: ["birthday"], kind: "return_gift", title: "Colouring kit with crayons and stickers", tags: ["kids", "budget"], perGuest: [80, 180], when: c => c.kid,
    description: "Better than plastic toys: it keeps them busy at home the next day too." },
  { types: ["birthday"], kind: "music", title: "Freeze-dance and musical-chairs playlist", tags: ["kids", "diy", "budget"], when: c => c.kid,
    description: "A 30-minute playlist of film songs kids know, with pauses for freeze dance and musical chairs." },
  { types: ["birthday"], kind: "invite_text", title: "WhatsApp invite with an RSVP line", tags: ["invite", "whatsapp", "kids"], when: c => c.kid,
    description: "\"You're invited to a jungle safari! Join us for games, a magic show and cake. Please reply with your child's name and any food allergies.\"" },
  { types: ["birthday"], kind: "photo", title: "Polaroid guestbook", tags: ["photo", "keepsake"], rupees: [3_000, 7_000], when: c => c.kid,
    description: "Each child gets one instant photo to stick in a book with a note: a keepsake for years." },
  // ---- birthdays (teens and adults)
  { types: ["birthday"], kind: "theme", title: "Retro Bollywood night", tags: ["adult", "theme", "dress code"], rupees: [15_000, 40_000], when: c => !c.kid,
    description: "Old film posters, a filmy dress code and a 'best Amitabh' prize: easy for guests to join in." },
  { types: ["birthday"], kind: "decor", title: "Neon sign and fairy-light canopy", tags: ["adult", "decor", "home"], rupees: [6_000, 18_000], when: c => !c.kid,
    description: "A custom neon name sign plus warm fairy lights overhead turns a living room or terrace into a party space; rent the neon to save." },
  { types: ["birthday"], kind: "music", title: "Acoustic guitarist for the first hour", tags: ["adult", "home", "live music"], rupees: [5_000, 12_000], when: c => !c.kid && c.home,
    description: "Soft live music while people arrive, then switch to a playlist; the right volume for an apartment." },
  { types: ["birthday"], kind: "menu", title: "Live pasta and mocktail counter", tags: ["adult", "live counter"], perGuest: [350, 700], when: c => !c.kid,
    description: "A chef-run counter plus three signature mocktails named after the guest of honour's favourite things." },
  { types: ["birthday"], kind: "activity", title: "Karaoke with a host", tags: ["adult", "music"], rupees: [8_000, 20_000], when: c => !c.kid,
    description: "A host keeps the queue moving and pulls the shy ones in; ask for a Hindi and Telugu song list." },
  { types: ["birthday"], kind: "music", title: "DJ for three hours", tags: ["adult", "dance"], rupees: [12_000, 30_000], when: c => !c.kid && !c.home,
    description: "Agree the playlist split up front (retro, current, regional) and a hard stop time for the neighbours." },
  { types: ["birthday"], kind: "return_gift", title: "Personalised mugs or coasters", tags: ["adult", "keepsake"], perGuest: [200, 400], when: c => !c.kid,
    description: "A line or inside joke printed on each: practical, and it says you thought about them." },
  { types: ["birthday"], kind: "invite_text", title: "Mystery dress-code invite", tags: ["invite", "adult"], when: c => !c.kid,
    description: "\"One night, one rule: come dressed as your favourite film character. Food, music and a surprise at 9.\"" },

  // ---- community: Ganesh
  { types: ["community"], kind: "decor", title: "Eco-friendly shadu-maati Ganesh idol", tags: ["ganesh", "eco-friendly", "idol"], rupees: [15_000, 60_000], when: c => has(c, /ganesh|ganapati|vinayaka|chaturthi/),
    description: "Natural clay with natural colours dissolves cleanly at visarjan; book early, artisans sell out weeks before." },
  { types: ["community"], kind: "activity", title: "Artificial immersion tank for visarjan", tags: ["ganesh", "eco-friendly", "visarjan"], rupees: [10_000, 30_000], category: "logistics", when: c => has(c, /ganesh|ganapati|vinayaka|chaturthi/),
    description: "Keeps the lake clean and the procession short; many municipalities also run tanks you can register for." },
  { types: ["community"], kind: "menu", title: "Modak and panchakhadya prasad counter", tags: ["ganesh", "prasad", "veg"], perGuest: [20, 50], when: c => has(c, /ganesh|ganapati|vinayaka|chaturthi/),
    description: "Steamed ukadiche modak for the aarti and a dry panchakhadya mix that keeps for daily distribution." },
  { types: ["community"], kind: "music", title: "Dhol-tasha pathak for the visarjan", tags: ["ganesh", "procession"], rupees: [25_000, 75_000], when: c => has(c, /ganesh|ganapati|vinayaka|chaturthi/),
    description: "Book the pathak's route and timing with the police permission so the procession isn't held up." },
  { types: ["community"], kind: "activity", title: "Kids' clay-Ganesh workshop", tags: ["ganesh", "kids", "eco-friendly"], rupees: [5_000, 15_000], when: c => has(c, /ganesh|ganapati|vinayaka|chaturthi/),
    description: "Children make small clay idols to take home: a great second-day activity that draws families in." },
  // ---- community: Diwali / Navratri / general
  { types: ["community"], kind: "activity", title: "Diya-painting and rangoli competition", tags: ["diwali", "kids", "budget"], rupees: [5_000, 15_000], when: c => has(c, /diwali|deepavali/),
    description: "Prizes for three age groups; use the finished rangolis as the walkway decor for the evening." },
  { types: ["community"], kind: "music", title: "Garba nights with a live band", tags: ["navratri", "garba", "live music"], rupees: [40_000, 120_000], when: c => has(c, /navratri|garba|dandiya/),
    description: "A live dhol and singer set for the last three nights draws the biggest crowds; record nights one to six from a playlist." },
  { types: ["community"], kind: "menu", title: "Fasting-friendly food stalls", tags: ["navratri", "veg", "stalls"], perGuest: [40, 90], when: c => has(c, /navratri|garba|ekadashi|fast/),
    description: "Sabudana khichdi, rajgira puri and fruit chaat: invite home cooks to run stalls as income for the fest." },
  { types: ["community"], kind: "theme", title: "Zero-waste festival", tags: ["eco-friendly", "community"], rupees: [8_000, 25_000], category: "logistics",
    description: "Steel plate bank, segregated bins with volunteers, and no single-use plastic at stalls: a theme sponsors like to back." },
  { types: ["community"], kind: "decor", title: "Marigold and LED-string gateway", tags: ["decor", "entrance", "community"], rupees: [15_000, 45_000],
    description: "A bamboo arch wrapped in marigold strings and warm LEDs at the main gate: the selfie spot everyone posts." },
  { types: ["community"], kind: "menu", title: "Local food-stall court", tags: ["stalls", "food", "community"], rupees: [5_000, 20_000], category: "logistics",
    description: "Six to eight stalls from neighbourhood kitchens and street-food favourites, with a common seating area and a water station." },
  { types: ["community"], kind: "music", title: "Local band and folk dance troupe", tags: ["live music", "folk", "culture"], rupees: [25_000, 70_000],
    description: "Book a regional folk troupe (bonalu, lavani or bhangra to suit the crowd) for the evening slot; schools often have great ones." },
  { types: ["community"], kind: "photo", title: "Live stream for elders and family abroad", tags: ["photo", "live stream"], rupees: [10_000, 25_000],
    description: "One phone on a gimbal with a good mic and a YouTube or Instagram live link shared on the society group." },
  { types: ["community"], kind: "return_gift", title: "Volunteer T-shirts in the festival colour", tags: ["volunteers", "community"], rupees: [6_000, 18_000], category: "gifts",
    description: "Makes volunteers easy to spot in a crowd and doubles as a thank-you; add a sponsor logo to cover the cost." },
  { types: ["community"], kind: "invite_text", title: "Society WhatsApp broadcast and poster", tags: ["invite", "whatsapp", "community"],
    description: "\"Our colony festival is here! Daily aarti at 7 PM, cultural nights, food stalls and a kids' corner. Volunteer or sponsor: reply to this message.\"" },
  { types: ["community"], kind: "activity", title: "Stall rentals for local businesses", tags: ["income", "stalls", "community"], rupees: [0, 0], category: "logistics",
    description: "Charge a small fee per stall to cover tents and power; food stalls bring the evening footfall." },
];

const KIND_WORDS: Record<IdeaKindT, RegExp> = {
  theme: /\btheme/, decor: /\bdecor|decoration|flower|floral|mandap/, menu: /\bmenu|food|dish|catering|snack|cake|dessert|sweet/,
  activity: /\bactivit|game|entertain|fun\b/, return_gift: /\breturn[ -]?gift|gift|favou?r/, invite_text: /\binvit/, music: /\bmusic|song|band|dj\b|dance/, photo: /\bphoto|video|camera|picture/,
};
/** Idea kinds a phrase mentions ("decor, food and return gifts" → decor, menu, return_gift). */
export const kindsIn = (text: string): IdeaKindT[] => IDEA_KINDS.filter(k => KIND_WORDS[k].test(text.toLowerCase()));

/** "under ₹50k", "below 1.5L", "within 20000" → a cap in paise for the low estimate. */
export function focusCapPaise(focus: string): number | null {
  const m = focus.replace(/,/g, "").match(/\b(?:under|below|within|less than|max(?:imum)?|upto|up to)\s*(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lakhs|lac)?\b/i);
  if (!m) return null;
  const n = Number(m[1]), u = (m[2] ?? "").toLowerCase();
  return Math.round(n * (u.startsWith("k") || u === "thousand" ? 1_000 : u.startsWith("l") ? 100_000 : 1) * 100);
}

function ctxOf(st: AgentState, focus: string): Ctx {
  const x = st.event.ext;
  const text = [st.event.city, st.event.notes, st.event.title, x.type === "wedding" ? x.traditions.join(" ") : x.type === "birthday" ? x.theme : x.organizer,
    st.subEvents.map(s => s.name).join(" "), focus].join(" ").toLowerCase();
  const kid = x.type === "birthday" && ((x.turningAge !== null && x.turningAge <= 12) || /\bkid|child|children|toddler/.test(text));
  return { type: st.event.eventType, kid, home: /\bat home\b|home party|house|terrace|apartment/.test(text), words: text, guests: st.event.guestCount || st.guests.length || 50 };
}

/**
 * The offline brain for ideas: a curated, Indian-relevant bank filtered by event type, age, traditions and the focus
 * phrase, ranked deterministically. Same plan + focus → same cards. Returns suggest_ideas-shaped input (rupees).
 */
export function demoIdeas(st: AgentState, opts: { focus?: string; kind?: IdeaKindT; count?: number } = {}): SuggestIdeasInput {
  const focus = (opts.focus ?? "").trim();
  const c = ctxOf(st, focus);
  const cap = focusCapPaise(focus);
  const named = kindsIn(focus);
  const kindHit = opts.kind ?? (named.length === 1 ? named[0] : undefined);
  const fwords = focus.toLowerCase().replace(/[^a-z0-9 -]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !/^(ideas?|give|some|more|under|below|with|for|the|and|style)$/.test(w));
  const taken = new Set(st.ideas.map(i => i.title.toLowerCase()));
  const total = (b: BankIdea): [number, number] | null => b.perGuest ? [b.perGuest[0] * c.guests, b.perGuest[1] * c.guests] : b.rupees ?? null;
  const scored = BANK.map((b, order) => {
    const hay = `${b.title} ${b.description} ${b.tags.join(" ")}`.toLowerCase();
    const score = fwords.filter(w => hay.includes(w) || hay.includes(w.replace(/-/g, " "))).length * 3 + (named.includes(b.kind) ? 4 : 0) + (b.when ? 1 : 0);
    return { b, order, score };
  }).filter(({ b }) => b.types.includes(c.type) && (!b.when || b.when(c)) && !taken.has(b.title.toLowerCase())
    && (!kindHit || b.kind === kindHit) && (cap === null || (total(b)?.[0] ?? 0) <= cap / 100));
  const pick = scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, opts.count ?? 6).map(({ b }) => {
    const t = total(b);
    return { kind: b.kind, title: b.title, description: b.description, tags: b.tags,
      ...(t && t[1] > 0 ? { estLowRupees: t[0], estHighRupees: t[1] } : {}), ...(b.category ? { budgetCategory: b.category } : {}) };
  });
  return { ideas: pick.length ? pick : [{ kind: "invite_text", title: "Personal thank-you voice notes", description: "Record a 20-second voice note for each family after the event: free, and people remember it.", tags: ["budget", "thank you"] }], ...(focus ? { focus } : {}) };
}

/**
 * v6: the offline answer to "Cheaper alternative", "Make it kid-friendly" and "More traditional" on one idea card.
 * Curated bank cards of the same kind that fit the refinement come first; when the bank has none, code derives one from
 * the source idea (a cheaper version at 60% of its estimate, rounded to ₹100). Always labelled Demo and Estimate.
 */
export function demoRefine(st: AgentState, refine: Refine): SuggestIdeasInput {
  const src = st.ideas.find(i => i.id === refine.ideaId);
  if (!src) return { ideas: [] as never };
  const c = { ...ctxOf(st, ""), ...(refine.mode === "kid_friendly" ? { kid: true } : {}) };
  const taken = new Set(st.ideas.map(i => i.title.toLowerCase()));
  const total = (b: BankIdea): [number, number] | null => b.perGuest ? [b.perGuest[0] * c.guests, b.perGuest[1] * c.guests] : b.rupees ?? null;
  const fits = (b: BankIdea) => {
    const t = total(b);
    if (refine.mode === "cheaper") return src.estLowPaise === null ? (t === null || t[0] === 0) : t === null || t[0] * 100 < src.estLowPaise;
    if (refine.mode === "kid_friendly") return b.tags.includes("kids");
    return b.tags.includes("traditional") || b.tags.includes("ritual");
  };
  const picks = BANK.filter(b => b.kind === src.kind && b.types.includes(c.type) && (!b.when || b.when(c as Ctx)) && !taken.has(b.title.toLowerCase()) && fits(b)).slice(0, 2);
  const out: z.input<typeof SuggestedIdea>[] = picks.map(b => {
    const t = total(b);
    return { kind: b.kind, title: b.title, description: b.description, tags: b.tags, ...(t && t[1] > 0 ? { estLowRupees: t[0], estHighRupees: t[1] } : {}), ...(b.category ? { budgetCategory: b.category } : {}) };
  });
  if (!out.length) {
    const r100 = (p: number | null) => (p === null ? undefined : Math.max(0, Math.round((p * 6) / 10 / 100 / 100) * 100));
    const base = src.title.replace(/^(Budget version|Kid-friendly|Traditional take): /, "");
    const derived = refine.mode === "cheaper"
      ? { title: `Budget version: ${base}`, description: `The same idea, scaled down: fewer pieces, local materials and a simpler setup. Roughly 60% of the original estimate.`,
          ...(src.estLowPaise !== null ? { estLowRupees: r100(src.estLowPaise), estHighRupees: r100(src.estHighPaise ?? src.estLowPaise) } : {}) }
      : refine.mode === "kid_friendly"
        ? { title: `Kid-friendly ${base.charAt(0).toLowerCase()}${base.slice(1)}`, description: "Adapted for children: shorter, safe materials, nothing sharp or fragile, and a role for the kids to play.",
            ...(src.estLowPaise !== null ? { estLowRupees: src.estLowPaise / 100, estHighRupees: (src.estHighPaise ?? src.estLowPaise) / 100 } : {}) }
        : { title: `Traditional take: ${base}`, description: "Rooted in local custom: marigold and mango leaves, brass and banana leaf, and the family's own rituals.",
            ...(src.estLowPaise !== null ? { estLowRupees: src.estLowPaise / 100, estHighRupees: (src.estHighPaise ?? src.estLowPaise) / 100 } : {}) };
    if (!taken.has(derived.title.toLowerCase())) out.push({ kind: src.kind, ...derived, title: derived.title.slice(0, 120), tags: [], ...(src.category ? { budgetCategory: src.category } : {}) });
  }
  return { ideas: out.length ? out : [{ kind: src.kind, title: `${REFINE_LABEL[refine.mode]} for ${src.title}`.slice(0, 120), description: "Ask the Co-Pilot for more options.", tags: [] }], focus: REFINE_LABEL[refine.mode] };
}

/** Plain-language summary of a prepared set, for the chat reply and the toast. */
export function ideasReply(p: PreparedIdeas, source: "gemini" | "demo"): string {
  const list = p.drafts.map(d => `${IDEA_KIND_LABEL[d.kind]}: ${d.title}${d.estLowPaise ? ` (${rupees(d.estLowPaise)}${d.estHighPaise && d.estHighPaise !== d.estLowPaise ? `–${rupees(d.estHighPaise)}` : ""})` : ""}`);
  const head = p.drafts.length ? `Here ${p.drafts.length === 1 ? "is 1 idea" : `are ${p.drafts.length} ideas`}${source === "demo" ? " from the curated Demo Mode bank" : ""}:\n- ${list.join("\n- ")}` : "Those ideas are all on your board already.";
  const notes = [p.flagged ? `${p.flagged} would cost more than is left in its category, so it's flagged.` : "", p.dropped.length ? `Skipped ${p.dropped.length} (${p.dropped.map(d => d.reason).join("; ")}).` : ""].filter(Boolean);
  return [head, ...notes, p.drafts.length ? "They're saved on the Ideas page, where you can keep, dismiss or add them to the plan." : ""].filter(Boolean).join("\n");
}
