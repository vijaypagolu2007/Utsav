// Demo Mode / Offline Fallback. If Gemini is unreachable (no key, Wi-Fi drops mid-pitch), these deterministic
// parsers turn the flagship prompts into the very same tool calls Gemini would emit, so the demo never breaks.
import type { AgentState, BudgetCategory } from "./schema";
import { type CommandInput, addDays, rupees, weekdayOf, Weekday, findSubEvent } from "./commands";
import type { InitializeEventPlanInput } from "./blueprint";
import { executeAgentTool, type AgentAction, type ChatResponse } from "./agent";
import { computePlanInsights } from "./insights";

// ---------- amount & phrase parsing ----------
/** "₹20k" → 2000000, "1.5L" → 15000000, "₹25,000" → 2500000, "2 crore" → 2000000000 (all paise). */
export function parseAmountPaise(text: string): number | null {
  const m = text.replace(/,/g, "").match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lakhs|lac|lacs|cr|crore|crores)?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("k") || unit === "thousand" ? 1_000 : unit.startsWith("l") ? 100_000 : unit.startsWith("c") ? 10_000_000 : 1;
  return Math.round(n * mult * 100);
}
const AMOUNT_RE = /(?:₹|rs\.?\s*|inr\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr)?\b/i;

const CATEGORY_WORDS: [RegExp, BudgetCategory][] = [
  [/decor|decoration|flower|floral|mandap|stage/i, "decor"],
  [/cater|food|lunch|dinner|meal/i, "catering"],
  [/venue|hall|ground|lounge/i, "venue"],
  [/photo|video|camera|film/i, "photo_video"],
  [/music|dj|sound|band/i, "music"],
  [/entertain|arcade|artist|performer/i, "entertainment"],
  [/attire|outfit|clothes|dress/i, "attire"],
  [/beauty|makeup|mehendi artist/i, "beauty"],
  [/stationery|invite|invitation|banner|signage/i, "stationery"],
  [/gift/i, "gifts"],
  [/logistic|transport|shuttle|cab|tent/i, "logistics"],
  [/permit|noc|licen[cs]e/i, "permits"],
  [/misc|contingency|buffer/i, "misc"],
];
const findCategory = (s: string) => CATEGORY_WORDS.find(([re]) => re.test(s))?.[1] ?? null;

function findSubEventRef(st: AgentState, s: string): string | null {
  const t = s.toLowerCase();
  const hit = st.subEvents.find(x => t.includes(x.slug) || t.includes(x.name.toLowerCase()));
  return hit?.slug ?? null;
}

/** Parse one clause into a command, or null. */
function parseClause(st: AgentState, clause: string): CommandInput | null {
  const c = clause.trim();
  // Budget: "cut ₹20k from decor", "reduce decor by 1.5L", "add ₹30,000 to catering"
  const cut = /\b(cut|reduce|trim|slash|lower|decrease|save)\b/i.test(c);
  const add = /\b(add|increase|raise|top ?up|boost)\b/i.test(c);
  if ((cut || add) && AMOUNT_RE.test(c)) {
    const amt = parseAmountPaise(c.match(AMOUNT_RE)![0]);
    const cat = findCategory(c.replace(AMOUNT_RE, " "));
    if (amt && cat) {
      const scope = findSubEventRef(st, c);
      return { op: "adjust_budget", category: cat, deltaPaise: cut ? -amt : amt, reason: "user request",
        ...(scope && st.budgetItems.some(b => b.category === cat && st.subEvents.find(s => s.slug === scope)?.id === b.subEventId) ? { subEvent: scope } : {}) };
    }
  }
  // Move: "move the Haldi to Friday", "shift sangeet to 2027-03-12"
  const mv = c.match(/\b(move|shift|reschedule|push|pull)\b.*?\bto\b\s+(.+)$/i);
  if (mv) {
    const se = findSubEventRef(st, c);
    if (se) {
      const target = mv[2]!.toLowerCase();
      const date = target.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (date) return { op: "move_sub_event", subEvent: se, to: { date } };
      const wd = Weekday.options.find(d => target.includes(d) || target.includes(d.slice(0, 3)));
      if (wd) return { op: "move_sub_event", subEvent: se, to: { weekday: wd } };
    }
  }
  // Task done: "mark 'book purohit' done", "complete the florist task"
  const done = c.match(/\b(mark|complete|finish|done)\b/i);
  if (done) {
    const t = st.tasks.find(x => x.title.toLowerCase().split(/\s+/).filter(w => w.length > 3).some(w => c.toLowerCase().includes(w)));
    if (t) return { op: "set_task_status", taskId: t.id, status: "done" };
  }
  return null;
}

// ---------- cold-start blueprints ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const titleCase = (s: string) => s.replace(/\b\w/g, ch => ch.toUpperCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** First given weekday on/after a date. Deterministic date code, not LLM arithmetic. */
function onOrAfter(date: string, wd: (typeof Weekday.options)[number]): string {
  let d = date;
  for (let i = 0; i < 7 && weekdayOf(d) !== wd; i++) d = addDays(d, 1);
  return d;
}

export function detectEventType(text: string): "wedding" | "birthday" | "community" | null {
  const t = text.toLowerCase();
  if (/wedding|shaadi|marriage|vivah|kalyanam/.test(t)) return "wedding";
  if (/birthday|bday|b-day|\b\d+(st|nd|rd|th)\b.*party|turning \d+/.test(t)) return "birthday";
  if (/mela|fest|festival|community|neighbou?rhood|diwali|ganesh|navratri|cultural|society|colony|carnival/.test(t)) return "community";
  return null;
}

/** Turn a one-sentence prompt into a full blueprint with weights (never paise) and day offsets (never dates). */
export function blueprintFromPrompt(text: string, today: string): InitializeEventPlanInput {
  const type = detectEventType(text) ?? "birthday";
  const amtMatch = text.match(/(?:₹|rs\.?\s*|inr\s*)\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr)\b/i);
  const defaults = { wedding: 2_500_000, birthday: 150_000, community: 500_000 };
  const budgetRupees = amtMatch ? Math.round(parseAmountPaise(amtMatch[0])! / 100) : defaults[type];
  const city = text.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/)?.[1] ?? (type === "birthday" ? "Mumbai" : "Hyderabad");
  const guests = Number(text.replace(/,/g, "").match(/(\d+)\s*(?:guests|people|attendees|pax|visitors)/i)?.[1] ?? (type === "wedding" ? 300 : type === "birthday" ? 40 : 500));
  const mIdx = MONTHS.findIndex(m => new RegExp(`\\b${m}[a-z]*\\b`, "i").test(text));
  const year = Number(text.match(/\b(20\d{2})\b/)?.[1] ?? 0);
  let anchor: string;
  if (mIdx >= 0) {
    let y = year || Number(today.slice(0, 4));
    if (!year && `${y}-${String(mIdx + 1).padStart(2, "0")}-28` < today) y++;
    anchor = `${y}-${String(mIdx + 1).padStart(2, "0")}-08`;
  } else anchor = addDays(today, type === "wedding" ? 120 : type === "birthday" ? 45 : 60);

  if (type === "wedding") {
    const days = Math.min(5, Math.max(2, Number(text.match(/(\d)\s*-?\s*day/i)?.[1] ?? 3)));
    const main = onOrAfter(anchor, "sunday");
    const start = addDays(main, -(days - 1));
    const names = text.match(/([A-Z][a-z]+)\s*(?:&|and)\s*([A-Z][a-z]+)/);
    const mainOff = days - 1;
    const recOff = days >= 4 ? days - 1 : mainOff; // a 3-day wedding has the reception on the wedding evening
    const subEvents = [
      { name: "Haldi", dayOffset: 0, startMin: 600, endMin: 780, phase: "pre" as const },
      { name: "Mehendi", dayOffset: 0, startMin: 990, endMin: 1200, phase: "pre" as const },
      { name: "Sangeet", dayOffset: Math.max(0, mainOff - 1), startMin: 1140, endMin: 1380, phase: "pre" as const },
      { name: "Muhurtham", dayOffset: days >= 4 ? mainOff - 1 : mainOff, startMin: 420, endMin: 720, phase: "main" as const, isMain: true },
      { name: "Reception", dayOffset: recOff, startMin: 1140, endMin: 1380, phase: "post" as const },
    ];
    if (days >= 4) subEvents[2]!.dayOffset = mainOff - 2;
    return {
      title: `${/south indian/i.test(text) ? "South Indian Wedding" : "Wedding"} — ${city}`, eventType: "wedding", city,
      startDate: start, totalBudgetRupees: budgetRupees, guestCount: guests, subEvents,
      budgetLines: [
        { category: "venue", label: "Wedding venue", subEvent: "Muhurtham", weightBps: 1600 },
        { category: "catering", label: "Muhurtham lunch", subEvent: "Muhurtham", weightBps: 1500 },
        { category: "catering", label: "Sangeet dinner", subEvent: "Sangeet", weightBps: 700 },
        { category: "catering", label: "Reception dinner", subEvent: "Reception", weightBps: 1000 },
        { category: "decor", label: "Mandap", subEvent: "Muhurtham", weightBps: 800 },
        { category: "decor", label: "Haldi marigold decor", subEvent: "Haldi", weightBps: 300 },
        { category: "decor", label: "Sangeet stage", subEvent: "Sangeet", weightBps: 500 },
        { category: "decor", label: "Reception florals", subEvent: "Reception", weightBps: 400 },
        { category: "photo_video", label: "Candid + cinematic film", weightBps: 800 },
        { category: "music", label: "Sangeet DJ & sound", subEvent: "Sangeet", weightBps: 300 },
        { category: "music", label: "Nadaswaram ensemble", subEvent: "Muhurtham", weightBps: 150 },
        { category: "attire", label: "Bride & groom attire", weightBps: 600 },
        { category: "beauty", label: "Bridal makeup", weightBps: 250 },
        { category: "stationery", label: "Invitations", weightBps: 150 },
        { category: "gifts", label: "Return gifts", weightBps: 200 },
        { category: "logistics", label: "Guest transport", weightBps: 250 },
        { category: "misc", label: "Contingency", weightBps: 500 },
      ],
      tasks: [
        { title: "Book venue & pay deposit", subEvent: "Muhurtham", dueOffsetDays: -150, priority: "high" },
        { title: "Book Muhurtham purohit", subEvent: "Muhurtham", dueOffsetDays: -120, priority: "high" },
        { title: "Shortlist caterers & tasting", subEvent: "Muhurtham", dueOffsetDays: -100, priority: "high" },
        { title: "Book photographer", subEvent: "Muhurtham", dueOffsetDays: -90, priority: "med" },
        { title: "Send invitations", subEvent: "Muhurtham", dueOffsetDays: -45, priority: "med" },
        { title: "Confirm Haldi florist", subEvent: "Haldi", dueOffsetDays: -14, priority: "med" },
        { title: "Mehendi artist trial", subEvent: "Mehendi", dueOffsetDays: -21, priority: "low" },
        { title: "Sangeet rehearsals", subEvent: "Sangeet", dueOffsetDays: -10, priority: "med" },
      ],
      timeline: [
        { subEvent: "Haldi", label: "Haldi application", startMin: 600, endMin: 690 },
        { subEvent: "Haldi", label: "Lunch", startMin: 690, endMin: 780 },
        { subEvent: "Muhurtham", label: "Baraat & welcome", startMin: 420, endMin: 470 },
        { subEvent: "Muhurtham", label: "Muhurtham", startMin: 470, endMin: 500, anchored: true },
        { subEvent: "Muhurtham", label: "Wedding lunch", lane: "catering", startMin: 630, endMin: 720 },
      ],
      ext: { type: "wedding", partners: names ? [names[1]!, names[2]!] : ["Partner 1", "Partner 2"],
        traditions: /south indian/i.test(text) ? ["south-indian", "hindu"] : ["hindu"] },
    };
  }

  if (type === "birthday") {
    const age = Number(text.match(/\b(\d{1,3})(?:st|nd|rd|th)\b/i)?.[1] ?? text.match(/turning\s+(\d+)/i)?.[1] ?? 0) || null;
    const themeRaw = text.match(/\d+(?:st|nd|rd|th)\s+(.+?)\s+(?:birthday|bday)/i)?.[1]
      ?? text.match(/(\w+(?:\s\w+)?)\s*-?themed/i)?.[1] ?? "Classic party";
    const theme = titleCase(themeRaw.replace(/^(a|an|the)\s+/i, ""));
    const honoree = text.match(/\bfor\s+([A-Z][a-z]+)\b(?!\s*(?:guests|people))/)?.[1] ?? text.match(/([A-Z][a-z]+)'s/)?.[1] ?? "the guest of honour";
    const day = onOrAfter(anchor, "saturday");
    const arcade = /arcade|retro|gam/i.test(theme);
    return {
      title: `${age ? `${age}${["th", "st", "nd", "rd"][age % 10 > 3 || Math.floor(age / 10) % 10 === 1 ? 0 : age % 10]} ` : ""}${theme} Birthday`,
      eventType: "birthday", city, startDate: day, totalBudgetRupees: budgetRupees, guestCount: guests,
      subEvents: [
        { name: "Setup", dayOffset: 0, startMin: 840, endMin: 1080, phase: "pre" },
        { name: "Party", dayOffset: 0, startMin: 1140, endMin: 1410, phase: "main", isMain: true },
        { name: "Brunch", dayOffset: 1, startMin: 660, endMin: 810, phase: "post" },
      ],
      budgetLines: [
        { category: "venue", label: arcade ? "Arcade lounge buyout" : "Party venue", subEvent: "Party", weightBps: 3000 },
        { category: "catering", label: "Food & mocktail bar", subEvent: "Party", weightBps: 2400 },
        { category: "decor", label: arcade ? "Neon signs & LED floor" : "Theme decor", subEvent: "Setup", weightBps: 1000 },
        { category: "entertainment", label: arcade ? "Arcade machine rental" : "Games & entertainment", subEvent: "Party", weightBps: 1300 },
        { category: "photo_video", label: "Photo booth", subEvent: "Party", weightBps: 500 },
        { category: "misc", label: "Cake", subEvent: "Party", weightBps: 450 },
        { category: "gifts", label: "Return gifts", weightBps: 400 },
        { category: "catering", label: "Brunch spread", subEvent: "Brunch", weightBps: 450 },
        { category: "logistics", label: "Cabs", weightBps: 300 },
      ],
      tasks: [
        { title: "Send e-invites", subEvent: "Party", dueOffsetDays: -30, priority: "high" },
        { title: arcade ? "Reserve arcade machines" : "Book entertainment", subEvent: "Party", dueOffsetDays: -28, priority: "high" },
        { title: "Confirm headcount with venue", subEvent: "Party", dueOffsetDays: -10, priority: "med" },
        { title: "Order cake", subEvent: "Party", dueOffsetDays: -7, priority: "med" },
        { title: "Build playlist", subEvent: "Party", dueOffsetDays: -3, priority: "low" },
      ],
      timeline: [
        { subEvent: "Party", label: "Doors & welcome drinks", startMin: 1140, endMin: 1200 },
        { subEvent: "Party", label: arcade ? "High-score tournament" : "Games", startMin: 1200, endMin: 1260 },
        { subEvent: "Party", label: "Cake & toast", startMin: 1290, endMin: 1310, anchored: true },
        { subEvent: "Party", label: "Dance floor", startMin: 1320, endMin: 1410 },
      ],
      ext: { type: "birthday", honoree, turningAge: age, theme,
        wishlist: arcade
          ? [{ item: "Mini arcade cabinet", approxRupees: 18000, priority: "high" }, { item: "Retro handheld console", approxRupees: 6000, priority: "high" }, { item: "Synthwave poster set", approxRupees: 2000, priority: "med" }]
          : [{ item: "Experience voucher", approxRupees: 5000, priority: "high" }, { item: "Books", approxRupees: 2000, priority: "med" }],
        activities: arcade
          ? [{ name: "Pac-Man high-score tournament", ageRange: [18, 45], durationMin: 45, supplies: ["Arcade cabinets", "Scoreboard", "Trophy"] },
             { name: "80s costume contest", durationMin: 30, supplies: ["Prizes"] }, { name: "Cake cutting", durationMin: 20, supplies: ["Cake", "Candles"] }]
          : [{ name: "Party games", durationMin: 45, supplies: ["Props"] }, { name: "Cake cutting", durationMin: 20, supplies: ["Cake", "Candles"] }] },
    };
  }

  // community
  const kind = text.match(/(diwali|ganesh|navratri|holi|christmas|eid|onam|sankranti|pongal|cultural)/i)?.[1];
  const form = text.match(/\b(mela|fest|festival|carnival|utsav)\b/i)?.[1] ?? "fest";
  const day = onOrAfter(anchor, "saturday");
  return {
    title: titleCase(`${/neighbou?rhood/i.test(text) ? "Neighbourhood " : ""}${kind ? kind + " " : "Community "}${form}`),
    eventType: "community", city, startDate: addDays(day, -1), totalBudgetRupees: budgetRupees, guestCount: guests,
    subEvents: [
      { name: "Volunteer Briefing", dayOffset: 0, startMin: 1080, endMin: 1200, phase: "pre" },
      { name: "Main Day", dayOffset: 1, startMin: 600, endMin: 1320, phase: "main", isMain: true },
      { name: "Cleanup & Thank-you", dayOffset: 2, startMin: 540, endMin: 720, phase: "post" },
    ],
    budgetLines: [
      { category: "venue", label: "Grounds / hall rental", subEvent: "Main Day", weightBps: 1800 },
      { category: "permits", label: "Permits & NOC fees", weightBps: 500 },
      { category: "decor", label: kind?.toLowerCase() === "diwali" ? "Lights, diyas & rangoli" : "Stage & lighting", subEvent: "Main Day", weightBps: 2000 },
      { category: "entertainment", label: "Performers & cultural troupes", subEvent: "Main Day", weightBps: 1800 },
      { category: "logistics", label: "Tents, chairs & sanitation", subEvent: "Main Day", weightBps: 1400 },
      { category: "catering", label: "Volunteer meals", weightBps: 600 },
      { category: "stationery", label: "Banners & signage", weightBps: 500 },
      { category: "photo_video", label: "Photos & live stream", weightBps: 400 },
      { category: "misc", label: "Security & first aid", weightBps: 1000 },
    ],
    tasks: [
      { title: "Apply for municipal permission", subEvent: "Main Day", dueOffsetDays: -30, priority: "high" },
      { title: "Pitch sponsors", subEvent: "Main Day", dueOffsetDays: -35, priority: "high" },
      { title: "Allot food & craft stalls", subEvent: "Main Day", dueOffsetDays: -21, priority: "med" },
      { title: "Publish volunteer roster", subEvent: "Volunteer Briefing", dueOffsetDays: -7, priority: "med" },
      { title: "Print banners", subEvent: "Main Day", dueOffsetDays: -10, priority: "low" },
    ],
    timeline: [
      { subEvent: "Main Day", label: "Inauguration", startMin: 600, endMin: 660, anchored: true },
      { subEvent: "Main Day", label: "Kids' activities", startMin: 660, endMin: 840 },
      { subEvent: "Main Day", label: "Stalls open", lane: "stalls", startMin: 660, endMin: 1320 },
      { subEvent: "Main Day", label: "Cultural performances", startMin: 1050, endMin: 1290 },
    ],
    ext: { type: "community", organizer: "Residents' Welfare Association", expectedFootfall: guests, volunteers: Math.max(10, Math.round(guests / 50)),
      sponsors: [
        { name: "Title sponsor (TBD)", tier: "title", pledgedRupees: Math.round(budgetRupees * 0.3), deliverables: ["Naming rights", "Stage backdrop"], status: "prospect" },
        { name: "Local business partner", tier: "gold", pledgedRupees: Math.round(budgetRupees * 0.1), deliverables: ["Banner logo", "Stall"], status: "prospect" },
      ],
      permits: [
        { authority: "Municipal corporation", kind: "Event permission", applyByOffsetDays: -21, feeRupees: 10000 },
        { authority: "Police", kind: "Public gathering NOC", applyByOffsetDays: -14, feeRupees: 5000 },
        { authority: "Fire services", kind: "Fire NOC", applyByOffsetDays: -14, feeRupees: 5000 },
      ] },
  };
}

// ---------- drafts ----------
function offlineDraft(st: AgentState, text: string): { channel: "whatsapp" | "email"; recipient: string; subject?: string; body: string; purpose: "vendor_negotiation" | "sponsor_pitch" | "guest_reminder" | "other" } | null {
  const t = text.toLowerCase();
  const channel = /email|mail/.test(t) ? "email" as const : "whatsapp" as const;
  const ext = st.event.ext;
  if (/sponsor|pitch/.test(t) && ext.type === "community") {
    const s = ext.sponsors.find(x => t.includes(x.name.toLowerCase())) ?? ext.sponsors.find(x => x.status === "prospect" || x.status === "pitched") ?? ext.sponsors[0];
    if (!s) return null;
    const main = st.subEvents.find(x => x.isMain);
    return { channel: "email", recipient: s.name, purpose: "sponsor_pitch", subject: `${st.event.title}: ${s.tier} sponsorship`,
      body: `Hi ${s.name} team,\n\n${ext.organizer || "We"} ${ext.organizer ? "is" : "are"} hosting ${st.event.title} in ${st.event.city} on ${main?.date ?? st.event.startDate}, expecting ${ext.expectedFootfall.toLocaleString("en-IN")}+ visitors.\n\nWe'd love you on board as our ${s.tier.replace("_", "-")} sponsor${s.pledgedPaise ? ` at ${rupees(s.pledgedPaise)}` : ""}. That includes: ${s.deliverables.join(", ") || "logo placement and a stall"}.\n\nCould we take 15 minutes this week to walk you through it?\n\nWarm regards,\n${ext.organizer || "The organising team"}` };
  }
  if (/rsvp|remind|guest/.test(t)) {
    const pending = st.guests.filter(g => Object.values(g.rsvp).some(v => v === "invited" || v === "maybe"));
    return { channel, recipient: `${pending.length} pending guests`, purpose: "guest_reminder",
      body: `Hi! A gentle reminder to RSVP for ${st.event.title} (${st.event.startDate}). Please let us know which events you can make it to, and any dietary needs. Can't wait to celebrate with you!` };
  }
  if (/negotiat|vendor|discount|photograph|caterer|decor/.test(t)) {
    const breach = st.budgetItems.find(b => b.quotedPaise !== null && b.quotedPaise > b.plannedPaise && (t.includes(b.category.split("_")[0]!) || /negotiat|vendor|discount/.test(t)));
    const b = breach ?? st.budgetItems.find(x => x.quotedPaise !== null);
    if (!b) return null;
    const v = st.vendors.find(x => x.id === b.vendorId);
    return { channel, recipient: v?.name ?? b.label, purpose: "vendor_negotiation", ...(channel === "email" ? { subject: `${b.label}: revised quote` } : {}),
      body: `Hi ${v?.name ?? "team"}, thank you for the quote of ${rupees(b.quotedPaise ?? 0)} for ${b.label}. We really like your work, but our budget for this is ${rupees(b.plannedPaise)}. Could you work with us on a package closer to that? We're happy to confirm quickly and pay the deposit this week.` };
  }
  return null;
}

/** The offline brain: same tools, deterministic parsing. */
export function runOfflineAgent(st: AgentState, text: string, today: string): ChatResponse {
  const actions: AgentAction[] = [];
  const t = text.trim();
  const lower = t.toLowerCase();

  // Cold start: "Switch to / plan / create … birthday|wedding|mela"
  if (/\b(switch to|plan|create|new|start|organi[sz]e|set up)\b/i.test(t) && detectEventType(t) && !/\bmove|cut|reduce\b/i.test(t)) {
    const r = executeAgentTool("initialize_event_plan", blueprintFromPrompt(t, today), st, today);
    actions.push(...r.actions);
    const init = r.actions.find(a => a.kind === "init");
    return { mode: "offline", actions, reply: init && init.kind === "init"
      ? `Drafted a fresh blueprint: ${init.log.join(". ")}. The budget is allocated from weights with largest-remainder rounding, so it sums to the paisa. Load it onto the canvas when you're ready.`
      : `I couldn't build that plan: ${String(r.response.reason)}` };
  }

  // Insights query
  if (/overdue|urgent|red flag|risk|insight|what('s| is) (due|pending)|status/i.test(lower) && !/\b(cut|move|add)\b/i.test(lower)) {
    const r = executeAgentTool("get_plan_insights", {}, st, today);
    actions.push(...r.actions);
    const pi = computePlanInsights(st, today);
    const od = pi.insights.filter(i => i.kind === "overdue_deposit");
    const ut = pi.insights.filter(i => i.kind === "urgent_task");
    const reply = [
      od.length ? `Overdue: ${od.map(i => `${i.title.replace(/: .*/, "")} (${i.detail})`).join("; ")}.` : "No deposits are overdue.",
      ut.length ? `Urgent tasks: ${ut.map(i => `${i.title} (${i.detail.split(" (")[0]})`).join("; ")}.` : "Nothing urgent in the next 14 days.",
      pi.insights.length > od.length + ut.length ? `Plus ${pi.insights.length - od.length - ut.length} other flag(s) in the card.` : "",
    ].filter(Boolean).join(" ");
    return { mode: "offline", actions, reply };
  }

  // Drafts (Tier 2)
  if (/\b(draft|write|compose|message|whatsapp|email|pitch|negotiat)\b/i.test(lower)) {
    const d = offlineDraft(st, t);
    if (d) {
      const r = executeAgentTool("draft_outbound_message", d, st, today);
      actions.push(...r.actions);
      return { mode: "offline", actions, reply: `Here's a draft for ${d.recipient}. Edit it, then copy or open it in ${d.channel === "email" ? "your mail app" : "WhatsApp"}. I never send on your behalf.` };
    }
  }

  // Mutations: split on "and" / "then" / "," into clauses → one atomic batch
  const clauses = t.split(/\s*(?:,|;|\band then\b|\bthen\b|\band\b)\s*/i).filter(Boolean);
  const commands = clauses.map(c => parseClause(st, c)).filter((c): c is CommandInput => c !== null);
  if (commands.length) {
    const summary = commands.map(c => c.op === "adjust_budget" ? `${c.deltaPaise < 0 ? "Cut" : "Add"} ${rupees(Math.abs(c.deltaPaise))} ${c.deltaPaise < 0 ? "from" : "to"} ${c.category}`
      : c.op === "move_sub_event" ? `Move the ${cap(c.subEvent)} to ${"date" in c.to ? c.to.date : cap(c.to.weekday)}` : c.op === "set_task_status" ? `Mark task done` : c.op).join("; ");
    const r = executeAgentTool("apply_plan_changes", { summary, commands }, st, today);
    actions.push(...r.actions);
    const res = r.response as { ok: boolean; tier?: number; reason?: string; log?: string[] };
    if (res.ok) {
      const batch = r.actions[0];
      const cascade = batch?.kind === "batch" ? batch.diff.cascadedTasks : 0;
      return { mode: "offline", actions, reply: `${summary}. ${res.tier === 0 ? "Applied." : "Here's the dry-run diff — approve it to commit."}${cascade ? ` ${cascade} task due date${cascade > 1 ? "s" : ""} cascade with it.` : ""}` };
    }
    const rj = r.actions.find(a => a.kind === "rejection");
    const counter = r.actions.find(a => a.kind === "batch" && a.counterOffer);
    let reply = `I couldn't do that: ${res.reason}. Nothing was changed.`;
    if (rj?.kind === "rejection") {
      const d = rj.rejection.diagnostics;
      const failed = commands[rj.rejection.failedCommandIndex];
      if (failed?.op === "adjust_budget") {
        const max = d.scopeMaxCuttablePaise ?? d.categoryMaxCuttablePaise[failed.category] ?? 0;
        reply = `I can't cut ${rupees(Math.abs(failed.deltaPaise))} from ${failed.category}: only ${rupees(max)} is unlocked slack above what's already committed${d.lockedItems?.length ? ` (${d.lockedItems.join(", ")} ${d.lockedItems.length > 1 ? "are" : "is"} locked)` : ""}. Nothing changed.`;
        if (counter) reply += ` Want me to cut the full ${rupees(max)} instead? Approve the counter-offer card.`;
      } else if (failed?.op === "move_sub_event") {
        let name = failed.subEvent;
        try { name = findSubEvent(st, failed.subEvent).name; } catch { /* keep ref */ }
        const valid = d.validDatesForSubEvent ?? [];
        reply = `${res.reason}, so I rolled the whole request back. ${name} can go on ${valid.map(v => `${cap(weekdayOf(v).slice(0, 3))} ${v}`).join(", ") || "no other date in the window"}.`;
        if (counter?.kind === "batch") {
          const to = counter.batch.commands.find(c => c.op === "move_sub_event");
          if (to && to.op === "move_sub_event" && "date" in to.to) reply += ` The closest workable option is ${cap(weekdayOf(to.to.date))} ${to.to.date}. Approve the counter-offer to use it.`;
        }
      }
    }
    return { mode: "offline", actions, reply };
  }

  return { mode: "offline", actions, reply:
    "Offline demo mode understands: budget cuts/top-ups (\"cut ₹20k from decor\"), moves (\"move the Haldi to Friday\"), \"what's overdue?\", drafts (\"draft a sponsor pitch\"), and new plans (\"plan a 30th arcade birthday in Mumbai for ₹1.5L\"). Add a GEMINI_API_KEY for free-form chat." };
}

// ---------- Guest / Committee Concierge (offline) ----------
const hm = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m < 720 ? "AM" : "PM"}`;
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 2));

function mentionedSubEvents(st: AgentState, t: string) {
  const lower = t.toLowerCase();
  const scored = st.subEvents.map(s => {
    const full = lower.includes(s.name.toLowerCase()) || lower.includes(s.slug) || lower.includes(s.slug.replace(/-/g, " ")) ? 10 : 0;
    const partial = s.name.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && lower.includes(w)).length;
    return { s, score: full + partial };
  }).filter(x => x.score > 0);
  const top = Math.max(0, ...scored.map(x => x.score));
  // Full-name mentions win; otherwise keep only the best partial match so a stray word ("volunteer") can't hijack it.
  return scored.filter(x => (top >= 10 ? x.score >= 10 : x.score === top)).sort((a, b) => b.score - a.score || a.s.date.localeCompare(b.s.date)).map(x => x.s);
}

/** Read-only concierge with guest-safe writes. Everything still goes through applyBatch with role "guest". */
export function runOfflineGuestAgent(st: AgentState, text: string, today: string, actingGuestId: string | null): ChatResponse {
  const t = text.trim();
  const lower = t.toLowerCase();
  const actions: AgentAction[] = [];
  const run = (summary: string, commands: CommandInput[]) => {
    const r = executeAgentTool("apply_plan_changes", { summary, commands }, st, today, "guest");
    actions.push(...r.actions);
    return r.response as { ok: boolean; reason?: string; log?: string[] };
  };
  const me = actingGuestId ? st.guests.find(g => g.id === actingGuestId) ?? null : null;

  // Organiser-only requests are sent to the reducer anyway, so the boundary (not the parser) says no.
  const organiserClauses = t.split(/\s*(?:,|;|\band\b)\s*/i).map(c => parseClause(st, c)).filter((c): c is CommandInput => c !== null && c.op !== "set_task_status");
  if (organiserClauses.length) {
    const res = run("Guest request", organiserClauses);
    return { mode: "offline", actions, reply: res.reason ?? "Guest Concierge Mode is read-only for budgets and schedules." };
  }

  const ext = st.event.ext;
  // Wishlist status question
  if (ext.type === "birthday" && /\b(unclaimed|still (available|open|free)|which (gifts|wishes|items)|what'?s left)\b/i.test(t)) {
    const open = ext.wishlist.filter(w => !w.claimedByGuestId);
    return { mode: "offline", actions, reply: open.length
      ? `Still unclaimed: ${open.map(w => `${w.item}${w.priority === "high" ? " (most wanted)" : ""}`).join(", ")}. Say "claim the …" and it's yours.`
      : "Every wish has been claimed. Nice!" };
  }
  // Wishlist claim
  if (ext.type === "birthday" && /\b(claim|i'?ll (get|buy|bring)|reserve)\b/i.test(t)) {
    const want = words(t);
    const item = [...ext.wishlist].map(w => ({ w, score: [...words(w.item)].filter(x => want.has(x)).length })).sort((a, b) => b.score - a.score)[0];
    if (!item || item.score === 0) return { mode: "offline", actions, reply: `Which gift? The wishlist has ${ext.wishlist.map(w => w.item).join(", ")}.` };
    if (!me) return { mode: "offline", actions, reply: "Pick who you are in the RSVP card first, then I can claim it for you." };
    const res = run(`${me.name} claims ${item.w.item}`, [{ op: "claim_wishlist_item", itemId: item.w.id, guestId: me.id }]);
    return { mode: "offline", actions, reply: res.ok ? `Done! "${item.w.item}" is claimed for you, ${me.name}. Nobody else can take it now.` : `I couldn't claim it: ${res.reason}` };
  }

  // Community sign-ups
  if (ext.type === "community" && /\b(volunteer|sign (me|\w+) up|sponsor)\b/i.test(t)) {
    const named = t.match(/[Ss]ign\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+up/)?.[1] ?? t.match(/\bI(?:'m| am)\s+([A-Z][a-z]+)/)?.[1] ?? t.match(/^([A-Z][a-zA-Z&.\s]+?)\s+(?:wants|would like|is keen)/)?.[1];
    const name = named ?? me?.name;
    if (!name) return { mode: "offline", actions, reply: "Happy to! What name should I put down?" };
    if (/sponsor/i.test(t)) {
      const tier = (["title", "gold", "silver"] as const).find(x => lower.includes(x)) ?? (lower.includes("in-kind") || lower.includes("in kind") ? "in_kind" : "silver");
      const res = run(`${name} sponsor interest`, [{ op: "community_signup", kind: "sponsor", name, tier }]);
      return { mode: "offline", actions, reply: res.ok ? `Thank you! ${name} is noted as a ${tier.replace("_", "-")} sponsor prospect; the committee will reach out.` : `Couldn't add that: ${res.reason}` };
    }
    const se = mentionedSubEvents(st, t)[0];
    const shift = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i)?.[1];
    const res = run(`${name} volunteers`, [{ op: "community_signup", kind: "volunteer", name, ...(se ? { subEvent: se.slug } : {}), ...(shift ? { shift } : {}) }]);
    return { mode: "offline", actions, reply: res.ok ? `You're on the volunteer list, ${name}${se ? ` for ${se.name} (${longDate(se.date)})` : ""}. See you at the briefing!` : `Couldn't sign up: ${res.reason}` };
  }

  // RSVPs (+ dietary meals)
  const answer = /\b(not attending|can'?t (make|come)|decline|won'?t|no to)\b/i.test(t) ? "no" : /\bmaybe|not sure|tentative\b/i.test(t) ? "maybe"
    : /\b(attend|attending|coming|yes|rsvp|confirm|will be there)\b/i.test(t) ? "yes" : null;
  if (answer && st.guests.length) {
    const hhWord = t.match(/(?:the\s+)?([A-Z][a-z]+)\s+(?:household|family)/)?.[1];
    const hh = hhWord ? st.households.find(h => h.label.toLowerCase().includes(hhWord.toLowerCase())) : undefined;
    const named = st.guests.filter(g => lower.includes(g.name.toLowerCase()));
    const guests = hh ? st.guests.filter(g => g.householdId === hh.id) : named.length ? named : me ? [me] : [];
    if (!guests.length) return { mode: "offline", actions, reply: hhWord ? `I couldn't find a ${hhWord} household on the list.` : "Pick who you are in the RSVP card first, or name the household." };
    let subs = mentionedSubEvents(st, t);
    if (!subs.length || /\ball\b|everything/i.test(t)) subs = st.subEvents.filter(s => guests.some(g => s.id in g.rsvp));
    const commands: CommandInput[] = guests.flatMap(g => subs.map(s => ({ op: "set_rsvp" as const, guestId: g.id, subEvent: s.slug, answer })));
    const meals = t.match(/(\d+)\s+([a-z-]+)\s+meals?/i);
    if (meals) {
      const n = Math.min(Number(meals[1]), guests.length), diet = meals[2]!.toLowerCase();
      const already = guests.filter(g => g.diet.includes(diet));
      const pick = [...already, ...guests.filter(g => !g.diet.includes(diet))].slice(0, n);
      for (const g of pick) commands.push({ op: "set_guest_diet", guestId: g.id, diet: [diet] });
    }
    const who = hh ? hh.label : guests.map(g => g.name).join(" & ");
    const res = run(`${who}: ${answer} for ${subs.map(s => s.name).join(" & ")}`, commands);
    return { mode: "offline", actions, reply: res.ok
      ? `Done. ${who} is marked ${answer === "yes" ? "attending" : answer} for ${subs.map(s => s.name).join(" and ")}${meals ? ` with ${meals[1]} ${meals[2]} meal${Number(meals[1]) > 1 ? "s" : ""}` : ""}.`
      : `I couldn't update that: ${res.reason}` };
  }

  // Questions: time, venue, dress code, itinerary
  const subs = mentionedSubEvents(st, t);
  if (subs.length) {
    return { mode: "offline", actions, reply: subs.map(s => `The ${s.name} is on ${longDate(s.date)}, ${hm(s.startMin)} to ${hm(s.endMin)}${s.venue ? ` at ${s.venue}` : ""}.${s.dressCode ? ` Dress code: ${s.dressCode}.` : ""}`).join(" ") };
  }
  if (/budget|cost|price|vendor|spend|paise|₹/i.test(t)) return { mode: "offline", actions, reply: "That's handled by the organisers, so I can't share it. I can help with timings, venues, dress codes and your RSVP." };
  const list = [...st.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)
    .map(s => `${s.name}: ${longDate(s.date)}, ${hm(s.startMin)}${s.venue ? `, ${s.venue}` : ""}`).join(" · ");
  return { mode: "offline", actions, reply: `Here's the itinerary: ${list}. Ask me about any event, or RSVP right here.` };
}
