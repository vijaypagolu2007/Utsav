// v6: the vendor checklist per event type. Each slot names a kind of vendor the event usually needs, the budget
// category it is paid from, what you need from them, and a curated bank of questions to ask (the Demo Mode answer to
// "Questions to ask"; live Gemini tailors its own). Status per slot is derived from the plan's vendors in vendors.ts,
// never stored, so it can't go stale. Nothing here is a price or an availability claim.
import type { AgentState, BudgetCategory, EventType } from "../schema";

export type ChecklistSlot = {
  /** Stable key, stored on a vendor as `need` and in vendorChecklist.notNeeded. Lowercase words joined by _. */
  key: string;
  label: string;
  category: BudgetCategory;
  /** What you need from this vendor, in one line. */
  need: string;
  /** Usually optional for this event type (shown, but "Optional"). */
  optional?: boolean;
  /** Shown only when this returns true for the plan (e.g. idol and visarjan only for a Ganesh pandal). */
  when?: (plan: AgentState) => boolean;
  /** Curated questions to ask before booking. */
  questions: string[];
};

const text = (p: AgentState) => [p.event.title, p.event.notes, p.subEvents.map(s => s.name).join(" "),
  p.event.ext.type === "wedding" ? p.event.ext.traditions.join(" ") : ""].join(" ").toLowerCase();
const PUJA = /ganesh|ganapati|vinayaka|chaturthi|durga|puja|pooja|sthapana|visarjan/;
const HINDU_RITUAL = (p: AgentState) => !/christian|church|muslim|nikah|walima|civil|registration/.test(text(p));

const WEDDING: ChecklistSlot[] = [
  { key: "venue", label: "Wedding venue", category: "venue", need: "Your dates held in writing, capacity for your guest count, and the hall's rules on timing, decor and outside caterers.",
    questions: ["Are our dates held in writing, and until when is the hold valid?", "What is the seated and floating capacity for our guest count?",
      "Which hours are included, and what does overtime cost per hour?", "Can we bring our own caterer and decorator, and is there a corkage or outside-vendor fee?",
      "Is power backup (generator) included, and for how many hours?", "What is the cancellation and date-change policy, and is any part of the deposit refundable?",
      "How many rooms for changing and for the families are included?"] },
  { key: "caterer", label: "Caterer", category: "catering", need: "A per-plate menu for your head count, with veg / Jain / no-onion-garlic handling, service staff and a tasting.",
    questions: ["Is the quote per plate or a package, and for how many guests exactly?", "What is the minimum guarantee, and what happens if fewer guests come?",
      "How are Jain and no-onion-garlic dishes kept separate?", "Are service staff, crockery, water and counters included?",
      "Is GST included in the quoted amount?", "When do you need the final head count?", "Can we do a tasting before we pay the deposit?"] },
  { key: "decorator", label: "Decorator", category: "decor", need: "A mandap and stage design with flower types, set-up and teardown times, and what is fresh versus artificial.",
    questions: ["Which flowers are fresh and which artificial?", "Does the quote cover set-up and teardown, and at what times?", "Are lighting and fabric drapes included?",
      "What changes in the design if we lower the budget by 20%?", "Do you have a photo of this exact setup from a past event?", "Who is our point of contact on the day?"] },
  { key: "photographer", label: "Photographer & video", category: "photo_video", need: "Candid and traditional coverage hours per sub-event, deliverables (photos, film, album) and delivery dates.",
    questions: ["How many hours and which sub-events does the quote cover?", "How many shooters (candid, traditional, video) will attend?",
      "When are the edited photos and the film delivered?", "Is a drone included, and do you handle the permission?", "Are raw files included, and in what format?",
      "Is the album included, and how many pages?", "What is the travel and stay policy if the venue is outside the city?"] },
  { key: "mehendi_artist", label: "Mehendi artist", category: "beauty", need: "How many artists, how many guests they can cover per hour, and the bride's design time.", optional: true,
    when: p => !/christian|church/.test(text(p)),
    questions: ["How many artists will come, and how many guests per hour can they cover?", "How long does the bridal design take?", "Is the henna natural and chemical-free?",
      "Is there a charge per guest or a flat fee?", "Do you need a trial session?"] },
  { key: "pandit", label: "Pandit / officiant", category: "misc", need: "The muhurtham fixed, the list of puja items you must buy, and how long the ceremony runs.",
    when: HINDU_RITUAL,
    questions: ["Which muhurtham timings suit our date?", "What puja items must we arrange, and which do you bring?", "How long will the ceremony run?",
      "Is dakshina fixed, and does it include assistants?", "Can parts of the ceremony be explained to guests in English or Telugu?"] },
  { key: "music", label: "Nadaswaram or DJ", category: "music", need: "Live music or a DJ for each sub-event, with sound equipment, hours and a playlist plan.",
    questions: ["Which sub-events and how many hours does the quote cover?", "Is the sound system included, and who sets it up?", "What happens if the event runs late?",
      "Can we share a must-play and do-not-play list?", "Does the venue's noise curfew affect the plan?"] },
  { key: "makeup", label: "Makeup artist", category: "beauty", need: "Looks per sub-event for the bride (and family, if wanted), with a trial and the products used.",
    questions: ["How many looks does the quote cover, and for which sub-events?", "Is a trial included?", "Which product brands do you use?",
      "Do you travel to the venue, and is travel charged extra?", "Is hairstyling and draping included?"] },
];

const BIRTHDAY: ChecklistSlot[] = [
  { key: "cake", label: "Cake", category: "catering", need: "Size for your head count, flavour, any egg-free or nut-free needs, and delivery time.",
    questions: ["What size do we need for our guest count?", "Can it be eggless or nut-free?", "Is delivery included, and at what time?",
      "Can you match our theme, and is there a design charge?", "How far in advance must we order?"] },
  { key: "decor", label: "Decor", category: "decor", need: "Theme decor for the space, with set-up time and what is reusable or biodegradable.",
    questions: ["What does the quote include (backdrop, balloons, table decor)?", "How long does set-up take, and when do you arrive?", "Are the balloons biodegradable?",
      "Do you take it down afterwards?", "Can we see photos of this theme from a past party?"] },
  { key: "entertainer", label: "Entertainer", category: "entertainment", need: "A show or host suited to the age group, with duration and space needed.",
    questions: ["How long is the show, and what age group is it for?", "How much space and what equipment do you need?", "Do you involve the birthday child?",
      "Is there an extra charge for travel or a second show?", "What happens if you are delayed?"] },
  { key: "venue", label: "Venue", category: "venue", need: "Only if not at home: capacity, timing, food rules and clean-up.", optional: true,
    questions: ["How many hours are included?", "Can we bring our own cake and food?", "Is clean-up included?", "Is there parking for guests?", "What is the cancellation policy?"] },
];

const COMMUNITY: ChecklistSlot[] = [
  { key: "tent_pandal", label: "Tent / pandal", category: "logistics", need: "Structure size, seating, flooring, lighting and set-up dates, with safety certification.",
    questions: ["What size structure and how many chairs does the quote cover?", "Is the structure fire-safety certified?", "What are the set-up and dismantling dates?",
      "Are flooring, fans and lights included?", "Who handles rain protection?"] },
  { key: "sound", label: "Sound", category: "music", need: "A sound system for the space and crowd size, with an operator and the permitted hours.",
    questions: ["Is an operator included for every session?", "What is the system's coverage for our crowd size?", "Do you comply with the police noise limits and hours?",
      "Is generator power included?", "Is there a backup microphone and mixer?"] },
  { key: "idol", label: "Idol", category: "decor", need: "An eco-friendly idol of the right height, delivered on time, with the base and decoration.", when: p => PUJA.test(text(p)),
    questions: ["Is the idol natural clay with natural colours?", "What height and weight, and does it fit our pandal?", "When and how will it be delivered?",
      "Is decoration of the idol included?", "Will it dissolve in an artificial immersion tank?"] },
  { key: "prasad", label: "Prasad", category: "catering", need: "Daily prasad quantities for your footfall, packed hygienically, with timing for each aarti.", when: p => PUJA.test(text(p)),
    questions: ["What quantity per day for our expected footfall?", "Is it packed, and in what packaging?", "What time will it be delivered each day?",
      "Can you do a fasting-friendly option?", "What is the per-kilo or per-packet rate?"] },
  { key: "performers", label: "Performers", category: "entertainment", need: "Artists or troupes for each slot, with performance length, stage and sound needs.", when: p => !PUJA.test(text(p)), optional: true,
    questions: ["How long is each performance?", "What stage size and sound do you need?", "Is travel included?", "Do you need a green room?", "What is the fee if the slot moves?"] },
  { key: "permits", label: "Permits", category: "permits", need: "Police, municipal and electricity permissions in time, with fees and reference numbers.",
    questions: ["Which permissions does this event need, and from which office?", "How long does each permission take?", "What are the fees?",
      "Which documents must we submit?", "Who will collect the approval?"] },
  { key: "visarjan_transport", label: "Visarjan transport", category: "logistics", need: "A vehicle and route for the immersion, timed with the police permission.", when: p => PUJA.test(text(p)),
    questions: ["What vehicle, and how many people can ride with the idol?", "Is the route agreed with the police?", "What time can you start?",
      "Is decoration of the vehicle included?", "What happens if the procession is delayed?"] },
];

const BY_TYPE: Record<EventType, ChecklistSlot[]> = { wedding: WEDDING, birthday: BIRTHDAY, community: COMMUNITY };

/** The checklist slots that apply to a plan (its event type, minus any whose `when` rules it out). */
export function checklistFor(plan: AgentState): ChecklistSlot[] {
  return BY_TYPE[plan.event.eventType].filter(s => !s.when || s.when(plan));
}
/** Every slot key across event types (for validation). */
export const ALL_CHECKLIST_KEYS: ReadonlySet<string> = new Set(Object.values(BY_TYPE).flat().map(s => s.key));
export const slotByKey = (plan: AgentState, key: string) => BY_TYPE[plan.event.eventType].find(s => s.key === key) ?? null;
