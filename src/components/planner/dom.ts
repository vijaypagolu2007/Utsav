// DOM helpers for the planner shell (moved out of PlannerApp in v8 Part 2, unchanged).
import { refAnchor, refFromHash } from "@/routes";

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
const visible = (el: Element) => el.getClientRects().length > 0;

/**
 * Bring what a URL hash points at into view and move focus to it: "#ref-<id>" is the row showing plan entity <id>
 * (falling back to whatever is highlighted, then the page's card), "#<section>" a card. With no usable target, focus
 * goes to the page's h1, which is where every client navigation lands. Rows that aren't focusable get tabindex=-1
 * (programmatic focus only, never a Tab stop); a closed <details> around the target is opened first.
 */
export function focusTarget(hash: string) {
  const main = document.getElementById("main");
  if (!main) return;
  const ref = refFromHash(hash);
  let el: HTMLElement | null = ref ? document.getElementById(refAnchor(ref)) : null;
  if (el) for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
  if (el && !visible(el)) el = null;
  if (!el && ref) el = Array.from(main.querySelectorAll<HTMLElement>(".hl-a, .hl-b")).find(visible) ?? null;
  if (!el && hash.length > 1 && !ref) el = document.getElementById(decodeURIComponent(hash.slice(1)));
  if (!el && ref) el = main.querySelector<HTMLElement>("section[id]");
  const heading = main.querySelector<HTMLElement>("h1");
  const target = el ?? heading;
  if (!target) return;
  if (!target.matches(FOCUSABLE)) target.setAttribute("tabindex", "-1");
  if (el) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
  target.focus({ preventScroll: !!el });
}
/** Run after the next two frames: the new page (and any highlight) has rendered and laid out by then. */
export const afterPaint = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
