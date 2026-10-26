// The organizer's pages: one route per part of the plan, all sharing the one client-side plan state that lives in
// the (planner) layout. Pure data and lookups (no React), so the nav, "Show me", the Co-Pilot's "changed on another
// page" links and the tests all agree on which page owns what.
import type { DiffRow } from "./diff";
import type { InsightKind } from "./insights";

export type PageId = "overview" | "budget" | "vendors" | "tasks" | "schedule" | "event" | "guests" | "ideas";
export type PlannerPage = { id: PageId; href: string; label: string; /** <title> prefix and, except on Overview, the h1. */ title: string; description: string };

export const APP_NAME = "Utsav Co-Pilot";
export const pageTitle = (title: string) => `${title} · ${APP_NAME}`;

/** In nav order. Each page also renders the matching card, whose <section id> is the page id. */
export const PAGES: readonly PlannerPage[] = [
  { id: "overview", href: "/", label: "Overview", title: "Overview", description: "Key figures, what needs attention and a summary of every page." },
  { id: "budget", href: "/budget", label: "Budget", title: "Budget", description: "Planned envelopes, commitments, deposits and vendors." },
  { id: "vendors", href: "/vendors", label: "Vendors", title: "Vendors", description: "The vendors this event needs, where each one stands, questions to ask, and quotes side by side." },
  { id: "tasks", href: "/tasks", label: "Tasks", title: "Tasks", description: "Every task with its derived due date, grouped by status." },
  { id: "schedule", href: "/schedule", label: "Schedule", title: "Schedule", description: "Sub-events, their run-of-show lanes and guest-link visibility." },
  { id: "event", href: "/event", label: "Event", title: "Event", description: "The parts specific to this kind of event: couple, diets and gift registry, wishlist and activities, or sponsors and permits." },
  { id: "guests", href: "/guests", label: "Guests", title: "Guests", description: "Households, phones and private invite links, imports from contacts, the group join link, and who changed which RSVP." },
  { id: "ideas", href: "/ideas", label: "Ideas", title: "Ideas", description: "Personalised themes, decor, menus, activities and more, sized to what is left in your budget." },
];

/** Pages outside the tab navigation: reached from the event switcher's "New plan" or on first run. */
export const SETUP_PATH = "/setup";
export const SETUP_TITLE = "New plan";

export const pageById = (id: PageId): PlannerPage => PAGES.find(p => p.id === id)!;
/** The page a pathname belongs to (trailing slashes and unknown paths fall back to Overview). */
export function pageForPath(pathname: string | null | undefined): PlannerPage {
  const p = (pathname ?? "/").replace(/\/+$/, "") || "/";
  return PAGES.find(x => x.href === p) ?? PAGES[0]!;
}
/** True on the setup page (no nav tab is current there). */
export const isSetupPath = (pathname: string | null | undefined) => ((pathname ?? "").replace(/\/+$/, "") || "/") === SETUP_PATH;

/** Where each kind of red flag lives, for "Show me". */
const INSIGHT_PAGE: Record<InsightKind, PageId> = {
  overdue_deposit: "budget", upcoming_deposit: "budget", envelope_breach: "budget", over_budget: "budget",
  urgent_task: "tasks", blocked_task: "tasks", permit_risk: "event", wishlist_unclaimed: "event", rsvp_pending: "guests", sponsor_gap: "event",
};
export const pageForInsight = (kind: InsightKind): PlannerPage => pageById(INSIGHT_PAGE[kind]);

/** Which page shows each kind of change in a plan diff. */
const DIFF_PAGE: Record<DiffRow["kind"], PageId> = {
  budget: "budget", budget_new: "budget", quote: "budget", vendor: "vendors", payment: "budget", lock: "budget",
  priorities: "budget", vendor_stage: "vendors", checklist: "vendors", task_dep: "tasks",
  task_due: "tasks", task_status: "tasks",
  sub_event: "schedule", block: "schedule",
  diet: "event", signup: "event", rsvp: "guests", wishlist: "event", permit: "event", sponsor: "event",
  event: "overview", basics: "overview",
  budget_removed: "budget", task_new: "tasks", idea: "ideas",
  guest: "guests", household: "guests", join: "guests", gift: "event", activity: "event",
};

/** The pages a change touched, in nav order, leaving out `current` (the page already on screen). */
export function pagesForDiff(rows: readonly Pick<DiffRow, "kind">[], current: PageId): PlannerPage[] {
  const hit = new Set(rows.map(r => DIFF_PAGE[r.kind]));
  return PAGES.filter(p => hit.has(p.id) && p.id !== current);
}

/** DOM id of the row that shows plan entity `id`, so "/budget#ref-b1" deep-links to (and focuses) that line. */
export const refAnchor = (id: string) => `ref-${id}`;
/** The entity id a "#ref-…" hash points at, or null. */
export function refFromHash(hash: string): string | null {
  const m = /^#ref-([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1]! : null;
}
