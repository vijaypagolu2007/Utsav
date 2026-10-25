"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { AgentState } from "@/schema";
import { applyBatch, type BatchInput, type BatchResult, type BatchSource, type Role } from "@/commands";
import { computePlanDiff } from "@/diff";
import { computePlanInsights, todayIST, type Insight } from "@/insights";
import { runOfflineAgent, runOfflineGuestAgent, runOfflineIdeas, runOfflineVendorQuestions } from "@/offline";
import type { Refine } from "@/ideas";
import type { AgentAction, ChatResponse } from "@/agent";
import { sampleQuote, scanToActions, SAMPLE_QUOTES, type ScanResponse } from "@/quote-scanner";
import { budgetLedgerCsv, runSheetHtml } from "@/export";
import { type History, type Store, freshHistory, historyOf, isFirstRun, loadStore, markOnboarded, saveStore, storedTitles } from "@/persistence";
import { presentationFor, requireTemplate, slotFor, templateLabel, type TemplateId } from "@/config/event-templates";
import { isSetupPath, pageForInsight, pageForPath, pagesForDiff, pageTitle, refAnchor, refFromHash, SETUP_PATH, type PlannerPage } from "@/routes";
import type { IdeaKind } from "@/schema";
import type { SetupInputRaw } from "@/setup";
import Welcome from "./Welcome";
import CommandBar from "./CommandBar";
import GuestMicrosite from "./GuestMicrosite";
import ChatSidebar, { type ChatMsg, type UIAction } from "./ChatSidebar";
import CopilotDrawer, { CopilotLauncher } from "./CopilotDrawer";
import { KpiStrip } from "./Overview";
import { PageTabBar, PageTabs } from "./PageNav";
import { useMediaQuery } from "./ui";
import { kpisFor } from "@/config/kpis";
import { kpiContext } from "@/kpis";
import { publicCount } from "@/visibility";
import ShareDialog from "./ShareDialog";
import { useSharedEvent } from "./useSharedEvent";
import { useCloudSync } from "./useCloudSync";
import AccountMenu, { CloudChoiceDialog } from "./AccountMenu";
import { PlannerContext, type PlannerState } from "./planner-context";

type SyncStatusKey = string | null;
export type Highlight = { ids: Set<string>; key: number };
/** A link in a toast: "changed on another page" after an AI edit, undo or sync. */
export type ToastLink = { href: string; label: string };
export type Toast = { id: number; tone: "emerald" | "rose" | "slate"; text: string; links?: ToastLink[] };
export type Commit = (batch: BatchInput, label?: string) => BatchResult;
export type ScanInput = { sampleId: string } | { file: File };
/** What creating a plan from the setup form returned: the plan is already loaded when ok. */
export type CreatePlanResult = { ok: true; mode: "gemini" | "offline"; warning?: string } | { ok: false; error: string; issues?: string[] };
/** What "Get more ideas" returned (the cards are already on the board when ok). */
export type IdeasResult = { ok: true; mode: "gemini" | "offline"; added: number; reply: string; warning?: string } | { ok: false; error: string };
/** v6: "Questions to ask" one kind of vendor (nothing in the plan changes). */
export type QuestionsResult = { ok: true; mode: "gemini" | "offline"; label: string; questions: string[]; warning?: string } | { ok: false; error: string };

let uid = 0;
let highlightSeq = 0;
const nid = () => `m${++uid}`;

const WELCOME: Record<Role, ChatMsg> = {
  organizer: { id: "welcome", role: "assistant",
    text: "Hi! I plan with you, but every rupee and date goes through a deterministic engine: I propose, it computes, you approve. Ask for ideas, try a suggestion below, scan a vendor quote, or ask anything." },
  guest: { id: "welcome", role: "assistant",
    text: "Welcome! I'm your event concierge. Ask me about timings, venues and dress codes, or RSVP, set meal preferences, claim a gift or sign up to volunteer right here." },
};

function download(name: string, content: string, type: string) {
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
function focusTarget(hash: string) {
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
const afterPaint = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));

/**
 * The organizer shell, rendered once by the (planner) layout around whichever page is open. It owns the plan state
 * (history, undo/redo, persistence), the Co-Pilot drawer, the share dialog, toasts and the page navigation, and hands
 * the plan to the pages through PlannerContext, so all of it survives client navigation. Guest View replaces the
 * page with the guest microsite and hides the organizer navigation.
 */
export default function PlannerApp({ children }: { children?: ReactNode }) {
  const [store, setStoreState] = useState<Store>(() => loadStore());
  // A brand-new browser (no saved plans, welcome never answered) gets the welcome screen instead of a sample plan.
  const [firstRun, setFirstRun] = useState(() => isFirstRun());
  const [ideasBusy, setIdeasBusy] = useState(false);
  const storeRef = useRef(store);
  const [today, setTodayState] = useState(() => store.today ?? todayIST());
  const [role, setRole] = useState<Role>("organizer");
  const [actingGuest, setActingGuest] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight>({ ids: new Set(), key: 0 });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [chats, setChats] = useState<Record<Role, ChatMsg[]>>({ organizer: [WELCOME.organizer], guest: [WELCOME.guest] });
  const chatsRef = useRef(chats);
  const [busy, setBusy] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [mode, setMode] = useState<"gemini" | "offline" | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // The Co-Pilot drawer is closed by default; its chat state stays here (and in ChatSidebar) whether it is open or not.
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // Pages an AI change (or undo, or a guest sync) touched other than the one on screen: linked from the drawer and toasts.
  const [elsewhere, setElsewhere] = useState<PlannerPage[]>([]);
  const copilotTitleId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  // Read by handlers that finish after an await (a chat reply), so it must be the page open *then*, not at send time.
  const pathRef = useRef(pathname);
  useLayoutEffect(() => { pathRef.current = pathname; }, [pathname]);
  const currentPage = pageForPath(pathname);
  const onSetup = isSetupPath(pathname);

  const hist = historyOf(store);
  const plan = hist.snaps[hist.idx]!.plan;
  const insights = computePlanInsights(plan, today);
  const template = presentationFor(store.active, plan);
  const actingGuestId = plan.guests.some(g => g.id === actingGuest) ? actingGuest : plan.guests[0]?.id ?? null;

  // ---------- state plumbing (refs mirror state for synchronous reads inside handlers) ----------
  const setStore = (s: Store) => { storeRef.current = s; setStoreState(s); saveStore(s); };
  const setHist = (h: History, t: TemplateId = storeRef.current.active) => setStore({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: h } });
  const setToday = (d: string) => { setTodayState(d); setStore({ ...storeRef.current, today: d }); };
  const currentHist = () => historyOf(storeRef.current);
  const current = () => { const h = currentHist(); return h.snaps[h.idx]!.plan; };
  const setMsgs = (r: Role, f: (m: ChatMsg[]) => ChatMsg[]) => { chatsRef.current = { ...chatsRef.current, [r]: f(chatsRef.current[r]) }; setChats(chatsRef.current); };

  const toast = (tone: Toast["tone"], text: string, links?: ToastLink[]) => {
    const id = ++uid;
    setToasts(t => [...t.slice(-3), { id, tone, text, links: links?.length ? links : undefined }]);
    setAnnouncement(links?.length ? `${text}. Also changed: ${links.map(l => l.label).join(", ")}.` : text);
    // Errors and toasts with a link stay up longer so there is time to read and use them (WCAG 2.2.1); every toast is
    // also in a polite live region.
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === "rose" || links?.length ? 9000 : 4500);
  };
  const linksTo = (pages: PlannerPage[]): ToastLink[] => pages.map(p => ({ href: p.href, label: p.label }));
  const flash = (ids: string[]) => {
    const key = ++highlightSeq; // alternates hl-a / hl-b, so a new highlight restarts the pulse
    setHighlight({ ids: new Set(ids), key });
    setTimeout(() => setHighlight(h => (h.key === key ? { ids: new Set(), key } : h)), 3100);
  };
  /**
   * The highlight pulses on whatever part is on screen. A change the user didn't make on this page (an AI proposal,
   * undo, a sync) can land on another page, so `notify` returns those pages and lists them for the Co-Pilot drawer.
   */
  const showChanges = (before: AgentState, after: AgentState, notify: boolean): PlannerPage[] => {
    const diff = computePlanDiff(before, after);
    flash(diff.changedIds);
    if (!notify) return [];
    const off = before.event.id === after.event.id ? pagesForDiff(diff.rows, pageForPath(pathRef.current).id) : [];
    setElsewhere(off);
    return off;
  };
  const push = (next: AgentState, label: string, notify = true): PlannerPage[] => {
    const t = slotFor(storeRef.current.active, next);
    const h = historyOf(storeRef.current, t);
    const before = h.snaps[h.idx]!.plan;
    setHist({ snaps: [...h.snaps.slice(0, h.idx + 1), { plan: next, label }].slice(-50), idx: Math.min(h.idx + 1, 49) }, t);
    return showChanges(before, next, notify);
  };

  /**
   * The only way the canvas changes: through the deterministic reducer, under the current role. The dashboard's own
   * controls commit with source "ui" (which also allows the inline-edit ops); AI proposals keep the default "agent".
   */
  const commitWith = (r: Role, batch: BatchInput, label?: string, source: BatchSource = "agent"): BatchResult => {
    const res = applyBatch(current(), batch, { role: r, source });
    if (res.ok) {
      // A direct edit is made on the page that shows it; anything else may have changed another page too.
      const off = push(res.state, label ?? batch.summary, source !== "ui");
      toast("emerald", `Applied: ${res.log.join(" · ") || batch.summary}`, linksTo(off));
    }
    else toast("rose", `Not applied: ${res.reason}`);
    return res;
  };
  const commit: Commit = (batch, label) => commitWith(role, batch, label, "ui");
  const loadPlan = (p: AgentState, label: string) => { push(p, label); toast("emerald", `Loaded ${p.event.title}`); };
  const switchTemplate = (t: TemplateId) => {
    if (t === storeRef.current.active) return;
    setStore({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: historyOf(storeRef.current, t) } });
    flash([]);
  };
  const resetTemplate = () => {
    const t = storeRef.current.active;
    setHist(freshHistory(t), t);
    toast("slate", `Reset to the clean ${templateLabel(requireTemplate(t))} preset`);
  };
  const goTo = (idx: number) => {
    const h = currentHist();
    if (idx < 0 || idx >= h.snaps.length || idx === h.idx) return;
    const before = h.snaps[h.idx]!.plan, after = h.snaps[idx]!.plan;
    setHist({ ...h, idx });
    const off = showChanges(before, after, true);
    if (off.length) toast("slate", `${idx < h.idx ? "Undid" : "Redid"}: ${h.snaps[idx < h.idx ? h.idx : idx]!.label}`, linksTo(off));
  };

  // ---------- shared guest links (server copy kept in sync; guest responses merged back in) ----------
  const shared = useSharedEvent(store.active, plan, merged => { const off = push(merged, "Synced guest responses"); toast("slate", "Guest responses synced", linksTo(off)); });

  // ---------- optional Google sign-in: cloud copy of the active slot (local storage stays the working copy) ----------
  // "Use cloud copy" replaces the plan on screen like loading a plan: the cloud copy was validated by the server's schema
  // and again on arrival, it lands as one history step (so the device's plan is one Undo away), and nothing is merged.
  const cloud = useCloudSync(store.active, plan, cloudPlan => { const off = push(cloudPlan, "Loaded cloud copy"); toast("slate", "Loaded the cloud copy", linksTo(off)); });
  const [choiceOpen, setChoiceOpen] = useState(false);
  const choicePending = cloud.status.state === "choose";
  const [choiceSeen, setChoiceSeen] = useState<SyncStatusKey>(null);
  const choiceKey: SyncStatusKey = cloud.status.state === "choose" ? `${cloud.status.reason}:${cloud.status.cloud.version}` : null;
  // Each new choice opens the dialog once; closing it decides later (the account panel reopens it).
  if (choiceKey !== choiceSeen) { setChoiceSeen(choiceKey); setChoiceOpen(!!choiceKey); }

  // ---------- chat ----------
  const setAction = (r: Role, msgId: string, actionId: string, patch: Partial<UIAction>) =>
    setMsgs(r, ms => ms.map(m => (m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => (a.id === actionId ? ({ ...a, ...patch } as UIAction) : a)) })));

  const ingest = (r: Role, res: Pick<ChatResponse, "reply" | "actions" | "warning"> & { mode?: ChatResponse["mode"] }, msgId: string) => {
    const ui: UIAction[] = res.actions.map((a: AgentAction) => ({ ...a, status: "pending" }) as UIAction);
    setMsgs(r, ms => [...ms, { id: msgId, role: "assistant", text: res.reply, actions: ui, mode: res.mode, warning: res.warning }]);
    if (res.mode) setMode(res.mode);
    for (const a of ui) {
      if ((a.kind === "batch" && a.tier === 0) || a.kind === "ideas") {
        const out = commitWith(r, a.batch, `${r === "guest" ? "Guest" : "AI"}: ${a.batch.summary}`);
        setAction(r, msgId, a.id, out.ok ? { status: "applied" } : { status: "failed", error: out.reason });
      }
    }
  };

  // ---------- first-run setup and the idea board ----------
  /** Setup form → /api/plan (Gemini drafts, code enforces the user's answers) → loaded as the active plan. */
  const createPlan = async (setup: SetupInputRaw): Promise<CreatePlanResult> => {
    try {
      const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setup: { ...setup, today }, forceOffline }) });
      const j = (await res.json().catch(() => ({}))) as { plan?: AgentState; mode?: "gemini" | "offline"; warning?: string; message?: string; issues?: { path: string; message: string }[] };
      if (!res.ok || !j.plan) return { ok: false, error: j.message ?? `The server answered ${res.status}`, issues: j.issues?.map(i => i.message) };
      // First run: the new plan starts its own history (nothing to undo back to). Later "New plan": pushed onto the slot's
      // history, so the plan it replaces is one Undo away and nothing the user made is ever lost.
      if (firstRun) setHist({ snaps: [{ plan: j.plan, label: `Created ${j.plan.event.title}` }], idx: 0 }, slotFor(storeRef.current.active, j.plan));
      else push(j.plan, `Created ${j.plan.event.title}`, false);
      markOnboarded();
      setFirstRun(false);
      if (j.mode) setMode(j.mode);
      toast("emerald", `Created ${j.plan.event.title} (${j.mode === "gemini" ? "Live AI" : "Demo Mode"})`);
      return { ok: true, mode: j.mode ?? "offline", warning: j.warning };
    } catch (e) {
      return { ok: false, error: `Couldn't reach the server (${e instanceof Error ? e.message : "error"}). Your answers are still here: try again.` };
    }
  };
  /** Welcome → "Explore a sample": keep the sample as the saved plan from now on. */
  const exploreSample = (t: TemplateId) => {
    const s: Store = { ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: historyOf(storeRef.current, t) } };
    setStore(s);
    markOnboarded();
    setFirstRun(false);
    router.push("/");
  };
  /** "Get more ideas": one suggest_ideas call (Gemini, or the curated bank offline); the cards land through applyBatch. */
  const requestIdeas = async (focus: string, kind?: IdeaKind, refine?: Refine): Promise<IdeasResult> => {
    if (ideasBusy) return { ok: false, error: "Already fetching ideas" };
    setIdeasBusy(true);
    const state = current();
    const text = refine ? `Refine idea ${refine.ideaId}: ${refine.mode.replace("_", " ")}` : `Suggest ideas${kind ? ` (${kind.replace("_", " ")})` : ""}${focus ? `: ${focus}` : ""}`;
    const finish = (out: Pick<ChatResponse, "reply" | "actions" | "mode" | "warning">): IdeasResult => {
      const added = out.actions.filter(a => a.kind === "ideas").reduce((n, a) => n + (a.kind === "ideas" ? a.ideas.length : 0), 0);
      for (const a of out.actions) if (a.kind === "ideas") commitWith("organizer", a.batch, `${a.source === "gemini" ? "AI" : "Demo"}: ${a.batch.summary}`);
      setMode(out.mode);
      if (!added) toast("slate", "No new ideas this time: try another focus");
      setAnnouncement(`${added} new idea${added === 1 ? "" : "s"} added.`);
      return { ok: true, mode: out.mode, added, reply: out.reply, warning: out.warning };
    };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", text }], state, today, forceOffline, role: "organizer", ideas: { ...(focus ? { focus } : {}), ...(kind ? { kind } : {}), ...(refine ? { refine } : {}) } }) });
      const j = (await res.json().catch(() => ({}))) as ChatResponse & { message?: string };
      if (!res.ok) return { ok: false, error: j.message ?? `The server answered ${res.status}` };
      return finish(j);
    } catch (e) {
      const out = runOfflineIdeas(state, today, focus, kind, refine);
      return finish({ ...out, warning: `Server unreachable (${e instanceof Error ? e.message : "error"}). Ideas came from the Demo Mode bank.` });
    } finally {
      setIdeasBusy(false);
    }
  };

  /** v6: "Questions to ask" for one vendor-checklist slot: Gemini, or the curated bank offline. Read-only. */
  const requestVendorQuestions = async (need: string): Promise<QuestionsResult> => {
    const state = current();
    const take = (out: Pick<ChatResponse, "actions" | "mode" | "warning" | "reply">): QuestionsResult => {
      const q = out.actions.find(a => a.kind === "questions");
      if (!q || q.kind !== "questions") return { ok: false, error: out.reply || "No questions came back" };
      setMode(out.mode);
      setAnnouncement(`${q.questions.length} questions for the ${q.label.toLowerCase()}.`);
      return { ok: true, mode: out.mode, label: q.label, questions: q.questions, warning: out.warning };
    };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", text: `Questions to ask: ${need}` }], state, today, forceOffline, role: "organizer", vendorQuestions: { need } }) });
      const j = (await res.json().catch(() => ({}))) as ChatResponse & { message?: string };
      if (!res.ok) return { ok: false, error: j.message ?? `The server answered ${res.status}` };
      return take(j);
    } catch (e) {
      return take({ ...runOfflineVendorQuestions(state, today, need), warning: `Server unreachable (${e instanceof Error ? e.message : "error"}). Questions came from the Demo Mode bank.` });
    }
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const r = role;
    // A message is always about the plan on screen: it never switches templates or resets anything. A sub-event this
    // plan doesn't have is answered by the reducer's own "No sub-event" explanation.
    setMsgs(r, ms => [...ms, { id: nid(), role: "user", text: t }]);
    setElsewhere([]);
    setBusy(true);
    const state = current();
    const history = chatsRef.current[r].filter(m => m.id !== "welcome").slice(-12).map(m => ({ role: m.role, text: m.text.slice(0, 4000) }));
    const replyId = nid();
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, state, today, forceOffline, role: r, actingGuestId }) });
      if (res.status >= 400 && res.status < 500) {
        // A client error is a real problem with the request: say so instead of pretending to answer.
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        ingest(r, { reply: `The server rejected that request: ${j.message ?? `HTTP ${res.status}`}.`, actions: [] }, replyId);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ingest(r, (await res.json()) as ChatResponse, replyId);
    } catch (e) {
      const out = r === "guest" ? runOfflineGuestAgent(state, t, today, actingGuestId) : runOfflineAgent(state, t, today);
      ingest(r, { ...out, warning: `Server unreachable (${e instanceof Error ? e.message : "error"}). Answered locally in Demo Mode.` }, replyId);
    } finally {
      setBusy(false);
    }
  };

  const scan = async (input: ScanInput) => {
    if (busy) return;
    if (role !== "organizer") { setRole("organizer"); }
    const label = "sampleId" in input ? `sample "${SAMPLE_QUOTES.find(s => s.id === input.sampleId)?.title ?? "Sample quote"}"` : `file "${input.file.name}"`;
    setMsgs("organizer", ms => [...ms, { id: nid(), role: "user", text: `Scan vendor quote: ${label}` }]);
    setElsewhere([]);
    setBusy(true);
    const state = current();
    const replyId = nid();
    try {
      const form = new FormData();
      form.set("state", JSON.stringify(state)); form.set("today", today); form.set("role", "organizer");
      if ("sampleId" in input) form.set("samplePresetId", input.sampleId); else form.set("file", input.file);
      const res = await fetch("/api/scan-quote", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as ScanResponse & { error?: string; message?: string };
      if (!res.ok) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      ingest("organizer", { reply: j.reply, actions: j.actions, warning: j.warning, mode: j.source === "gemini" ? "gemini" : "offline" }, replyId);
      if (j.actions.some(a => a.kind === "batch")) toast("slate", "Quote read. Review the red flags and approve to update the budget.");
      else setAnnouncement("Quote scan finished.");
    } catch (e) {
      const q = "sampleId" in input ? sampleQuote(input.sampleId, today) : null;
      if (q) ingest("organizer", { ...scanToActions(q, state, today, "organizer", "sample"), warning: "Server unreachable: parsed the sample locally." }, replyId);
      else { ingest("organizer", { reply: `I couldn't scan that file: ${e instanceof Error ? e.message : "error"}.`, actions: [] }, replyId); setAnnouncement("Quote scan failed."); }
    } finally {
      setBusy(false);
    }
  };

  const approveAs = (r: Role, msgId: string, a: UIAction) => {
    if (a.kind === "batch") {
      const out = commitWith(r, a.batch, `${r === "guest" ? "Guest" : "AI"}: ${a.batch.summary}`);
      setAction(r, msgId, a.id, out.ok ? { status: "applied" } : { status: "failed", error: out.reason });
    } else if (a.kind === "init") {
      loadPlan(a.plan, `AI blueprint: ${a.plan.event.title}`);
      setAction(r, msgId, a.id, { status: "loaded" });
    }
  };
  const rejectAs = (r: Role, msgId: string, a: UIAction) => setAction(r, msgId, a.id, { status: "rejected" });

  const exportCsv = () => download(`${plan.event.id}-budget-ledger.csv`, budgetLedgerCsv(plan), "text/csv;charset=utf-8");
  const exportRunSheet = () => {
    const w = window.open("", "_blank");
    if (w) { w.document.open(); w.document.write(runSheetHtml(plan, today)); w.document.close(); }
    else download(`${plan.event.id}-run-sheet.html`, runSheetHtml(plan, today), "text/html;charset=utf-8");
  };

  // Dashboard actions whose answer lands in the chat (AI pitch, scanning a quote) open the drawer so the result is visible.
  const askFromDashboard = (text: string) => { setCopilotOpen(true); void send(text); };
  const scanFromDashboard = (input: ScanInput) => { setCopilotOpen(true); void scan(input); };
  const copilotTitle = role === "guest" ? "Guest Concierge" : "AI Co-Pilot";

  // ---------- pages ----------
  /** "Show me": highlight the flagged rows, go to the page that owns them and focus the first one (or its card). */
  const showInsight = (i: Insight) => {
    const page = pageForInsight(i.kind);
    flash(i.refs);
    const hash = i.refs[0] ? `#${refAnchor(i.refs[0])}` : `#${page.id}`;
    if (pageForPath(pathRef.current).id === page.id) afterPaint(() => focusTarget(hash));
    else router.push(`${page.href}${hash}`, { scroll: false });
  };
  // Every client navigation moves focus to the new page's h1 (or the "#ref-…" target a link named), so keyboard and
  // screen-reader users start at the top of the new content. Next's route announcer reads the new <title>.
  // On the first load, a "#ref-…" deep link also highlights its row.
  const firstLoad = useRef(true);
  useEffect(() => {
    const hash = window.location.hash;
    const first = firstLoad.current;
    firstLoad.current = false;
    if (first && !hash) return; // a plain first load keeps focus at the top of the document (the skip link comes first)
    const ref = first ? refFromHash(hash) : null;
    if (ref) requestAnimationFrame(() => flash([ref]));
    afterPaint(() => focusTarget(hash));
  }, [pathname]);

  const guest = role === "guest";
  // Guest View is a page of its own: its own title while it is open, the open route's title again when it closes.
  // Next re-applies the route's metadata title on its own re-renders, so hold ours while Guest View is showing.
  useEffect(() => {
    if (!guest) return;
    const want = pageTitle("Guest View");
    const apply = () => { if (document.title !== want) document.title = want; };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => { mo.disconnect(); document.title = pageTitle(pageForPath(pathRef.current).title); };
  }, [guest]);

  const wide = useMediaQuery("(min-width: 768px)", true);
  const kpiCtx = kpiContext(plan, today);
  const copilotDialogId = `${copilotTitleId}-dialog`;
  const ctx: PlannerState = { plan, today, insights, template, role, highlight, busy, commit, flash, showInsight, ask: askFromDashboard, scan: scanFromDashboard,
    createPlan, requestIdeas, ideasBusy, aiMode: mode, forceOffline, requestVendorQuestions };
  const offPage = elsewhere.filter(p => p.id !== currentPage.id);

  if (firstRun) return <PlannerContext value={ctx}><Welcome onCreate={createPlan} onSample={exploreSample} /></PlannerContext>;

  return (
    <PlannerContext value={ctx}>
    <div className="min-h-dvh w-full">
      {/* First stop for keyboard users: jump past the header and the page navigation straight to the page content. */}
      <a href="#main" className="sr-only rounded-lg bg-sand-900 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:px-4 focus:py-3">Skip to main content</a>
      <CommandBar
        plan={plan} today={today} setToday={setToday} insights={insights} activeTemplate={store.active}
        storedTitles={storedTitles(store)}
        onSwitch={switchTemplate} onReset={resetTemplate} role={role} setRole={setRole}
        history={hist.snaps.map(s => s.label)} historyIdx={hist.idx} goTo={goTo} showInsight={showInsight}
        onExportCsv={exportCsv} onExportRunSheet={exportRunSheet} onShare={() => setShareOpen(true)} shared={!!shared.share}
        launcher={<CopilotLauncher ref={launcherRef} open={copilotOpen} onOpen={() => setCopilotOpen(true)} title={copilotTitle} dialogId={copilotDialogId} guest={guest} />}
        nav={!guest && wide ? <PageTabs current={onSetup ? null : currentPage.id} /> : null}
        onNewPlan={() => router.push(SETUP_PATH)}
        account={<AccountMenu cloud={cloud} onOpenChoice={() => setChoiceOpen(true)} />}
      />
      <CloudChoiceDialog open={choiceOpen && choicePending && !guest} status={cloud.status} localTitle={plan.event.title}
        onUseCloud={() => { setChoiceOpen(false); cloud.chooseCloud(); }} onKeepLocal={() => { setChoiceOpen(false); cloud.chooseLocal(); }}
        onClose={() => setChoiceOpen(false)} />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} share={shared.share} status={shared.status}
        onPublish={() => void shared.publish()} onSync={shared.syncNow} onForget={shared.forget} visibility={publicCount(plan)} />
      {/* The page scrolls as one document. The Co-Pilot launcher lives in the header, so nothing floats over content;
          below 768px the organizer view reserves room for the bottom tab bar and its safe-area inset. */}
      <main id="main" tabIndex={-1} data-testid="dashboard" data-page={guest ? "guest" : onSetup ? "setup" : currentPage.id}
        className={`min-w-0 px-3 pb-8 pt-4 focus-visible:outline-none sm:px-4 lg:px-6 lg:pt-6 ${guest ? "" : "max-md:pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+2rem)]"}`}>
        {guest ? (
          <GuestMicrosite template={template} plan={plan} today={today} commit={commit} highlight={highlight} actingGuestId={actingGuestId} setActingGuestId={setActingGuest}
            summary={<KpiStrip kpis={kpisFor("guest", plan.event.eventType)} ctx={kpiCtx} guest />} />
        ) : children}
      </main>
      {!guest && !wide && <PageTabBar current={onSetup ? null : currentPage.id} />}
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} titleId={copilotTitleId} dialogId={copilotDialogId} launcherRef={launcherRef}>
        <ChatSidebar
          messages={chats[role]} busy={busy} onSend={send} onApprove={(m, a) => approveAs(role, m, a)} onReject={(m, a) => rejectAs(role, m, a)} onScan={scan}
          mode={mode} forceOffline={forceOffline} setForceOffline={setForceOffline} plan={plan} role={role}
          actingGuestName={plan.guests.find(g => g.id === actingGuestId)?.name ?? null}
          titleId={copilotTitleId} onClose={() => setCopilotOpen(false)} announcement={announcement}
          elsewhere={guest ? [] : linksTo(offPage)}
        />
      </CopilotDrawer>
      {/* Toasts sit above the bottom tab bar (and its safe-area inset) on small screens, so they never cover it or the last section. */}
      <div role="status" aria-live="polite"
        className={`pointer-events-none fixed left-3 right-3 z-40 flex flex-col gap-2 sm:right-auto sm:max-w-md md:bottom-4 md:left-4 ${guest ? "bottom-[calc(1rem+env(safe-area-inset-bottom))]" : "bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]"}`}>
        {toasts.map(t => (
          <div key={t.id} className={`toast-in pointer-events-auto break-words rounded-xl px-4 py-3 text-sm shadow-lg ${t.tone === "emerald" ? "bg-emerald-700 text-white" : t.tone === "rose" ? "bg-red-700 text-white" : "bg-sand-800 text-white"}`}>
            {t.text}
            {t.links && !guest && (
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Also changed:</span>
                {t.links.map(l => (
                  <Link key={l.href} href={l.href} className="inline-flex min-h-8 items-center font-semibold underline underline-offset-2">
                    View {l.label.toLowerCase()}<span className="sr-only"> page</span>
                  </Link>
                ))}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
    </PlannerContext>
  );
}
