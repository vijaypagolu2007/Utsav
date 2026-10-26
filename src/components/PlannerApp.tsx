"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { type History, type Store, freshHistory, historyOf, isFirstRun, loadStore, markOnboarded, saveStore } from "@/persistence";
import { isTemplateId, presentationFor, requireTemplate, slotFor, templateLabel, TEMPLATES, type TemplateId } from "@/config/event-templates";
import {
  hasMeaningfulLocalEdits, hasNoEvents, isOwnEvent, isPristineSample, loadFirstChoice, mayCreateCloudCopy, needsCloudProbe, sampleRemoved, saveFirstChoice,
  shouldShowFirstChoice, switcherSections, unmarkRemoved, type CloudPlans, type FirstChoice,
} from "@/my-events";
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
import ShareDialog from "./ShareDialog";
import { useSharedEvent } from "./useSharedEvent";
import { useCloudSync } from "./useCloudSync";
import AccountMenu, { CloudChoiceDialog } from "./AccountMenu";
import FirstChoiceDialog from "./FirstChoiceDialog";
import { loadSyncBase } from "@/cloud-sync";
import { decideOpening, forgetThisDevice, signInHref, signInSkipped, SIGNIN_PATH, wasSignedInOnDevice } from "@/signin";
import { PlannerContext, type PlannerState } from "./planner-context";
import ConfirmDialog from "./ConfirmDialog";
import {
  afterDeleteTarget, canDelete, isSampleSlot, loadHideSamples, loadTrash, moveToTrash, purgeExpired, restoreFromTrash, restoreSamples as withSamplesRestored,
  saveHideSamples, saveTrash, samplesHidden, TRASH_RETENTION_DAYS, UNDO_MS, type TrashItem,
} from "@/trash";

type SyncStatusKey = string | null;
export type Highlight = { ids: Set<string>; key: number };
/** A link in a toast: "changed on another page" after an AI edit, undo or sync. */
export type ToastLink = { href: string; label: string };
/** v8 Part 0c: a button in a toast ("Undo" after a delete). */
export type ToastAction = { label: string; onClick: () => void; testId: string };
export type Toast = { id: number; tone: "emerald" | "rose" | "slate"; text: string; links?: ToastLink[]; action?: ToastAction };
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

/** v8 Part 0b: an untouched sample only gets a cloud copy once this account chose "Load sample events" (or edits it). */
const mayCreate = (account: string, planKey: string, p: AgentState) =>
  !isTemplateId(planKey) || mayCreateCloudCopy({ pristineSample: isPristineSample(planKey, p), choice: loadFirstChoice(account) });

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
  // v8 Part 1c: in Guest View the preview acts as one RSVP entry (picked on its RSVP card, or the one it just sent).
  const actingEntryId = plan.rsvpEntries.some(e => e.id === actingGuest && !e.removedAt && !e.mergedInto) ? actingGuest : null;

  // ---------- state plumbing (refs mirror state for synchronous reads inside handlers) ----------
  const setStore = (s: Store) => { storeRef.current = s; setStoreState(s); saveStore(s); };
  // v8 Part 0d: whatever lands in a slot (an edit, a new event, a cloud copy, Undo) makes it a listed slot again.
  const setHist = (h: History, t: TemplateId = storeRef.current.active) => setStore(unmarkRemoved({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: h } }, t));
  const setToday = (d: string) => { setTodayState(d); setStore({ ...storeRef.current, today: d }); };
  const currentHist = () => historyOf(storeRef.current);
  const current = () => { const h = currentHist(); return h.snaps[h.idx]!.plan; };
  const setMsgs = (r: Role, f: (m: ChatMsg[]) => ChatMsg[]) => { chatsRef.current = { ...chatsRef.current, [r]: f(chatsRef.current[r]) }; setChats(chatsRef.current); };

  const toast = (tone: Toast["tone"], text: string, links?: ToastLink[], action?: ToastAction) => {
    const id = ++uid;
    setToasts(t => [...t.slice(-3), { id, tone, text, links: links?.length ? links : undefined, action }]);
    setAnnouncement(links?.length ? `${text}. Also changed: ${links.map(l => l.label).join(", ")}.` : text);
    // Errors and toasts with a link stay up longer so there is time to read and use them (WCAG 2.2.1); every toast is
    // also in a polite live region. An Undo toast stays UNDO_MS (10 s); Recently deleted keeps the same choice for 30 days.
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? UNDO_MS : tone === "rose" || links?.length ? 9000 : 4500);
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
    // `now` stamps the organizer's RSVP change log (v8 Part 1). Previews and dry runs leave it out, so they log nothing.
    // v8 Part 1c: in Guest View the preview acts as one RSVP entry, so it may only change that entry.
    const res = applyBatch(current(), batch, { role: r, source, now: new Date().toISOString(), ...(r === "guest" && actingEntryId ? { actorEntryId: actingEntryId } : {}) });
    if (res.ok) {
      // A direct edit is made on the page that shows it; anything else may have changed another page too.
      const off = push(res.state, label ?? batch.summary, source !== "ui");
      toast("emerald", `Applied: ${res.log.join(" · ") || batch.summary}`, linksTo(off));
    }
    else toast("rose", `Not applied: ${res.reason}`);
    return res;
  };
  const commit: Commit = (batch, label) => commitWith(role, batch, label, "ui");
  /**
   * v8 Part 1e: a dashboard edit whose toast carries Undo for UNDO_MS (10 s), like deleting an event. Undo steps the
   * history back only while this edit is still the latest step; after another edit the header's Undo/Redo is the way back.
   */
  const commitUndoable: Commit = (batch, label) => {
    const res = applyBatch(current(), batch, { role, source: "ui", now: new Date().toISOString() });
    if (!res.ok) { toast("rose", `Not applied: ${res.reason}`); return res; }
    push(res.state, label ?? batch.summary, false);
    const testId = `undo-edit-${++uid}`;
    toast("slate", `${res.log.join(" · ") || batch.summary}.`, undefined, { label: "Undo", testId, onClick: () => {
      setToasts(t => t.filter(x => x.action?.testId !== testId));
      const h = currentHist();
      if (h.snaps[h.idx]?.plan === res.state && h.idx > 0) goTo(h.idx - 1);
      else toast("rose", "Not undone: the plan changed since. Use Undo in the header.");
    } });
    return res;
  };
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
  // v8 Part 0c: the deletion callbacks are defined further down (they use the share hook and the router); a ref bridges them.
  const deletionRef = useRef<{ onRemoteDelete: (k: string, at: number) => void; onRestoreFromCloud: (k: string, p: AgentState) => boolean }>({ onRemoteDelete: () => {}, onRestoreFromCloud: () => false });
  const cloud = useCloudSync(store.active, plan, cloudPlan => { const off = push(cloudPlan, "Loaded cloud copy"); toast("slate", "Loaded the cloud copy", linksTo(off)); }, mayCreate, {
    onRemoteDelete: (k, at) => deletionRef.current.onRemoteDelete(k, at),
    onRestoreFromCloud: (k, p) => deletionRef.current.onRestoreFromCloud(k, p),
    isPristine: (k, p) => isTemplateId(k) && isPristineSample(k, p),
    isRemoved: k => isTemplateId(k) && sampleRemoved(storeRef.current, k),
  });
  // ---------- v8: sign-in-first opening (decided client-side after mount: this component never renders on the server) ----------
  // Read once per mount; a sign-in seen while the planner is open counts as "signed in on this device" from then on
  // and ends this session's "without an account" choice (the same flags the sign-in page writes).
  const [device] = useState(() => ({ before: wasSignedInOnDevice(), skipped: signInSkipped() }));
  const [seenUser, setSeenUser] = useState(false);
  if (cloud.user && !seenUser) setSeenUser(true);
  const opening = decideOpening({ authReady: cloud.authReady, signedIn: !!cloud.user, previouslySignedIn: device.before || seenUser, skipped: device.skipped && !seenUser, firstRun });
  // Signed out on a device someone signed in on: the sign-in page first (it comes back here afterwards).
  // Replacing twice under Strict Mode's double effect lands on the same URL, so it is harmless.
  useEffect(() => { if (opening === "signin") router.replace(signInHref(pathRef.current)); }, [opening, router]);
  // Signed in on a brand-new browser: straight to the plan (decideOpening), and the welcome counts as answered.
  const signedIn = !!cloud.user;
  useEffect(() => { if (signedIn && firstRun) markOnboarded(); }, [signedIn, firstRun]);
  /** Sign out; "Also remove this plan from this device" clears this browser's plans first and reloads on /signin, so nothing stays in memory either. */
  const signOutAndLeave = async (removeFromDevice: boolean) => {
    if (removeFromDevice) forgetThisDevice();
    await cloud.signOut();
    if (removeFromDevice) window.location.replace(SIGNIN_PATH);
  };
  const [choiceOpen, setChoiceOpen] = useState(false);
  const choicePending = cloud.status.state === "choose";
  const [choiceSeen, setChoiceSeen] = useState<SyncStatusKey>(null);
  const choiceKey: SyncStatusKey = cloud.status.state === "choose" ? `${cloud.status.reason}:${cloud.status.cloud.version}` : null;
  // Each new choice opens the dialog once; closing it decides later (the account panel reopens it).
  if (choiceKey !== choiceSeen) { setChoiceSeen(choiceKey); setChoiceOpen(!!choiceKey); }

  // ---------- v8 Part 0b: My events / Samples, and the first sign-in choice ----------
  const account = cloud.user?.uid ?? null;
  // The per-account answer lives in localStorage; reading it during render is safe because this component is client-only (ssr: false).
  const [choiceRead, setChoiceRead] = useState<{ uid: string | null; choice: FirstChoice | null }>({ uid: null, choice: null });
  if (choiceRead.uid !== account) setChoiceRead({ uid: account, choice: loadFirstChoice(account) });
  const firstChoice = choiceRead.uid === account ? choiceRead.choice : loadFirstChoice(account);
  const events = useMemo(() => switcherSections(store), [store]);
  const localEdits = useMemo(() => hasMeaningfulLocalEdits(store), [store]);
  const wantProbe = needsCloudProbe({ signedIn: !!account, answered: !!firstChoice, localEdits });
  const [probe, setProbe] = useState<{ uid: string | null; result: CloudPlans }>({ uid: null, result: "unknown" });
  const probedUid = probe.uid;
  const cloudProbe = cloud.probe;
  useEffect(() => {
    if (!wantProbe || !account || probedUid === account) return;
    // Strict Mode runs this twice: the first run's answer is dropped (live = false) and the second one's kept.
    let live = true;
    void cloudProbe(TEMPLATES.map(t => t.id)).then(result => { if (live) setProbe({ uid: account, result }); });
    return () => { live = false; };
  }, [wantProbe, account, probedUid, cloudProbe]);
  const cloudPlans: CloudPlans = probe.uid === account ? probe.result : "unknown";
  // "Decide later" (Escape) hides the chooser until the next time the planner opens; nothing is recorded.
  const [chooserLater, setChooserLater] = useState(false);
  const chooserOpen = shouldShowFirstChoice({ signedIn: !!account, answered: !!firstChoice, cloudPlans, localEdits }) && !chooserLater;
  const rememberChoice = (c: FirstChoice) => { if (account) { saveFirstChoice(account, c); setChoiceRead({ uid: account, choice: c }); } };
  /** "Start your own event": the blank setup form; the samples stay on this device only. */
  const startOwnEvent = () => { rememberChoice("own"); router.push(SETUP_PATH); };
  // v8 Part 0d: "Hide samples" (per device), and bringing deleted or hidden samples back.
  const [hidePref, setHidePref] = useState(() => loadHideSamples());
  const toggleHideSamples = () => { const v = !hidePref; setHidePref(v); saveHideSamples(v); };
  /**
   * Every deleted sample comes back as a fresh copy and "Hide samples" is switched off. A sample that was in the account
   * is saved over its cloud tombstone the next time its slot syncs (the same path as Restore); a local-only one stays local.
   */
  const bringSamplesBack = (): TemplateId[] => {
    const r = withSamplesRestored(storeRef.current);
    if (r.restored.length) {
      setStore(r.store);
      for (const slot of r.restored) cloud.markRestored(slot, historyOf(r.store, slot).snaps[0]!.plan);
    }
    if (hidePref) { setHidePref(false); saveHideSamples(false); }
    return r.restored;
  };
  /** "Restore samples" (event menu, and the setup form when nothing is left). */
  const restoreSampleEvents = () => {
    // The slot on screen, if it was a deleted sample's placeholder, now holds its fresh sample too.
    bringSamplesBack();
    const listed = switcherSections(storeRef.current).samples;
    toast("emerald", listed.length ? `Samples restored: ${listed.map(e => e.title).join(", ")}` : "Your own events are using every sample's place.");
    if (isSetupPath(pathRef.current)) router.push("/");
  };
  /**
   * "Load sample events": the samples open as usual (edits and the organizer's own events are kept), and from now on
   * they save to this account. The sample on screen is saved right away.
   */
  const loadSampleEvents = () => {
    rememberChoice("samples");
    // v8 Part 0d: deleted (or hidden) samples come back first, as fresh copies.
    bringSamplesBack();
    const s = storeRef.current;
    const onSample = !isOwnEvent(s.active, historyOf(s).snaps[historyOf(s).idx]!.plan);
    const target = onSample ? s.active : TEMPLATES.map(t => t.id as TemplateId).find(id => !isOwnEvent(id, historyOf(s, id).snaps[historyOf(s, id).idx]!.plan));
    if (target && target !== s.active) switchTemplate(target);
    else cloud.retry();
    const listed = switcherSections(storeRef.current).samples;
    toast("emerald", listed.length ? `Sample events loaded: ${listed.map(e => e.title).join(", ")}. Switch between them from the event menu.` : "Your own events are using every sample's place.");
    if (isSetupPath(pathRef.current)) router.push("/");
  };

  // ---------- v8 Part 0c: delete, Recently deleted, restore ----------
  // Items older than 30 days are purged when the planner opens; their cloud tombstones are removed once signed in.
  const [trashInit] = useState(() => purgeExpired(loadTrash(), Date.now()));
  const [trash, setTrashState] = useState<TrashItem[]>(trashInit.kept);
  const trashRef = useRef(trash);
  const setTrash = (items: TrashItem[]) => { trashRef.current = items; setTrashState(items); saveTrash(items); };
  useEffect(() => { if (trashInit.purged.length) saveTrash(trashInit.kept); }, [trashInit]);
  const purgedSent = useRef(false);
  const cloudDeleteForever = cloud.deleteForever;
  useEffect(() => {
    if (!account || purgedSent.current || !trashInit.purged.length) return;
    purgedSent.current = true;
    for (const i of trashInit.purged) if (!i.localOnly) void cloudDeleteForever(i.slot, i.eventId);
  }, [account, trashInit, cloudDeleteForever]);
  /** The decision on screen: delete one event, or delete a trashed one forever. `after` hears whether it was confirmed. */
  const [confirmState, setConfirm] = useState<{ kind: "delete"; slot: TemplateId; title: string; after?: (ok: boolean) => void } | { kind: "forever"; id: string; title: string } | null>(null);

  /**
   * Leave a slot whose event just went to the trash: another own event; after deleting a sample, the next sample still
   * listed; the setup form when the last own event went; and the setup form (which offers "Restore samples") when
   * nothing at all is left. v8 Part 0d: never a blank screen.
   */
  const afterRemoval = (s: Store, slot: TemplateId, wasSample: boolean): Store => {
    const target = afterDeleteTarget(s, slot, wasSample);
    if (target.kind !== "switch") {
      if (!isSetupPath(pathRef.current)) router.push(SETUP_PATH);
      // The active slot stays; when it was the deleted one it now holds its untouched sample, or (a deleted sample) a
      // placeholder that is never listed, shown or synced.
      return { ...s, byType: { ...s.byType, [s.active]: historyOf(s) } };
    }
    if (s.active !== slot) return s;
    const byType = { ...s.byType };
    delete byType[slot];
    return { ...s, active: target.slot, byType: { ...byType, [target.slot]: historyOf(s, target.slot) } };
  };
  const removeSlot = (slot: TemplateId, deletedAt: number, localOnly = false): TrashItem | null => {
    const s = storeRef.current;
    const h = historyOf(s, slot);
    const deleted = h.snaps[h.idx]!.plan;
    if (!canDelete(slot, deleted, s)) return null;
    const share = shared.detach(slot);
    const res = moveToTrash(s, slot, deletedAt, share);
    if (!res) return null;
    setStore(afterRemoval(res.store, slot, isSampleSlot(slot, deleted)));
    const item: TrashItem = localOnly ? { ...res.item, localOnly: true } : res.item;
    setTrash([item, ...trashRef.current.filter(i => i.id !== item.id)]);
    flash([]);
    return res.item;
  };
  const restoreEvent = (id: string): boolean => {
    const r = restoreFromTrash(storeRef.current, trashRef.current, id);
    if (!r.ok) { toast("rose", r.message); return false; }
    setStore(r.store);
    setTrash(r.items);
    if (r.item.share) shared.attach(r.item.slot, r.item.share);
    if (!r.item.localOnly) cloud.markRestored(r.item.slot, r.item.history.snaps[r.item.history.idx]!.plan);
    flash([]);
    toast("emerald", `Restored ${r.item.title}`);
    if (isSetupPath(pathRef.current)) router.push("/");
    return true;
  };
  /** Confirmed: the event moves to Recently deleted, the planner moves on, and a toast offers Undo for 10 s. */
  const deleteEvent = (slot: TemplateId) => {
    const s = storeRef.current;
    const h = historyOf(s, slot);
    const deleted = h.snaps[h.idx]!.plan;
    // v8 Part 0d: an untouched sample that never went to the account (no cloud copy known here, samples not loaded) is
    // only hidden on this device: no cloud write. Anything else, samples included, takes the Part 0c tombstone path.
    const localOnly = isPristineSample(slot, deleted) && !(account && (firstChoice === "samples" || loadSyncBase(account, slot)));
    const item = removeSlot(slot, Date.now(), localOnly);
    if (!item) { toast("rose", "That event is already deleted."); return; }
    if (!localOnly) cloud.markDeleted(slot, deleted);
    toast("slate", `Deleted ${item.title}. Restore it from Recently deleted in the event menu for ${TRASH_RETENTION_DAYS} days.`, undefined,
      { label: "Undo", onClick: () => { setToasts(t => t.filter(x => x.action?.testId !== `undo-${item.id}`)); restoreEvent(item.id); }, testId: `undo-${item.id}` });
  };
  const requestDelete = (slot: TemplateId, after?: (ok: boolean) => void) => {
    const h = historyOf(storeRef.current, slot);
    const p = h.snaps[h.idx]!.plan;
    if (!canDelete(slot, p, storeRef.current)) { after?.(false); toast("rose", "There is no event here to delete."); return; }
    setConfirm({ kind: "delete", slot, title: p.event.title, after });
  };
  const requestDeleteForever = (id: string) => {
    const item = trashRef.current.find(i => i.id === id);
    if (item) setConfirm({ kind: "forever", id, title: item.title });
  };
  const deleteForever = (id: string) => {
    const item = trashRef.current.find(i => i.id === id);
    if (!item) return;
    setTrash(trashRef.current.filter(i => i.id !== id));
    if (!item.localOnly) void cloud.deleteForever(item.slot, item.eventId);
    toast("slate", `${item.title} was deleted forever`);
  };
  const deletion: typeof deletionRef.current = {
    onRemoteDelete: (k, at) => {
      if (!isTemplateId(k)) return;
      const item = removeSlot(k, at);
      if (item) toast("slate", `${item.title} was deleted on another device. Restore it from Recently deleted in the event menu.`);
    },
    onRestoreFromCloud: (k, p) => {
      if (!isTemplateId(k)) return false;
      const item = trashRef.current.find(i => i.slot === k && i.eventId === p.event.id);
      const withCloud: TrashItem = item ? { ...item, history: { snaps: [...item.history.snaps, { plan: p, label: "Restored with the other device's edits" }], idx: item.history.snaps.length } }
        : { id: `${p.event.id}@cloud`, slot: k, eventId: p.event.id, title: p.event.title, eventType: p.event.eventType, deletedAt: Date.now(), history: { snaps: [{ plan: p, label: "Restored from the cloud" }], idx: 0 }, share: null };
      const items = [withCloud, ...trashRef.current.filter(i => i.id !== withCloud.id)];
      const r = restoreFromTrash(storeRef.current, items, withCloud.id);
      if (!r.ok) { toast("rose", r.message); return false; }
      setStore(r.store);
      setTrash(r.items);
      if (r.item.share) shared.attach(r.item.slot, r.item.share);
      toast("emerald", `Restored ${r.item.title} with the other device's edits`);
      return true;
    },
  };
  useEffect(() => { deletionRef.current = deletion; });
  const ownCount = events.mine.length;
  // Samples can only be hidden while there is an event of the organizer's own ("Explore a sample" never disappears).
  const hideSamples: boolean | null = ownCount > 0 ? samplesHidden(hidePref, ownCount) : null;
  const activeIsSample = isSampleSlot(store.active, plan);
  // v8 Part 0d: every event deleted (samples too). The setup form shows, with "Restore samples"; never a blank screen.
  const noEvents = events.mine.length === 0 && events.samples.length === 0;
  /** "Restore samples" in the event menu: some sample was deleted, or the samples are hidden. */
  const samplesMissing = events.removed.length > 0 || hideSamples === true;
  useEffect(() => { if (noEvents && opening === "plan" && !isSetupPath(pathRef.current)) router.replace(SETUP_PATH); }, [noEvents, opening, pathname, router]);

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
      // v8 Part 0d: with every event deleted, the new event also starts its own history (the slot only held a placeholder).
      if (firstRun || hasNoEvents(storeRef.current)) setHist({ snaps: [{ plan: j.plan, label: `Created ${j.plan.event.title}` }], idx: 0 }, slotFor(storeRef.current.active, j.plan));
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
    const s: Store = unmarkRemoved({ ...storeRef.current, active: t, byType: { ...storeRef.current.byType, [t]: historyOf(storeRef.current, t) } }, t);
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
        body: JSON.stringify({ messages: history, state, today, forceOffline, role: r, actingEntryId }) });
      if (res.status >= 400 && res.status < 500) {
        // A client error is a real problem with the request: say so instead of pretending to answer.
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        ingest(r, { reply: `The server rejected that request: ${j.message ?? `HTTP ${res.status}`}.`, actions: [] }, replyId);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ingest(r, (await res.json()) as ChatResponse, replyId);
    } catch (e) {
      const out = r === "guest" ? runOfflineGuestAgent(state, t, today, actingEntryId) : runOfflineAgent(state, t, today);
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
    // v8 Part 0c: an approved delete_event card deletes nothing yet: the app's own confirm comes next.
    if (a.kind === "batch" && a.batch.commands.some(c => c.op === "delete_event")) {
      if (r !== "organizer") { setAction(r, msgId, a.id, { status: "failed", error: "Only the organizer can delete the event" }); return; }
      // v8 Part 0d: samples too (Tier 2, organizer only); the confirm is the same.
      requestDelete(storeRef.current.active, ok => {
        if (ok) setAction(r, msgId, a.id, { status: "applied" });
        else if (!canDelete(storeRef.current.active, current(), storeRef.current)) setAction(r, msgId, a.id, { status: "failed", error: "There is no event here to delete" });
      });
      return;
    }
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

  // With every event deleted there is nothing to show guests (v8 Part 0d): the organizer's setup form shows instead.
  const guest = role === "guest" && !noEvents;
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
  const ctx: PlannerState = { plan, today, insights, template, role, highlight, busy, commit, commitUndoable, flash, showInsight, ask: askFromDashboard, scan: scanFromDashboard,
    createPlan, requestIdeas, ideasBusy, aiMode: mode, forceOffline, requestVendorQuestions,
    eventActions: { isSample: activeIsSample, requestDelete: () => requestDelete(storeRef.current.active), resetSample: resetTemplate, noEvents, restoreSamples: restoreSampleEvents },
    sharing: { share: shared.share, status: shared.status, publish: () => void shared.publish(), syncNow: shared.syncNow, resetInvite: shared.resetInvite, setJoinLink: shared.setJoinLink, resetRsvpLink: shared.resetRsvpLink,
      openShare: () => setShareOpen(true) } };
  const offPage = elsewhere.filter(p => p.id !== currentPage.id);

  if (opening === "signin" || opening === "wait") {
    // The local plan stays hidden until the organizer signs in or chooses "Use without an account" on /signin.
    return (
      <main id="main" data-testid="planner-locked" data-opening={opening} className="grid min-h-dvh place-items-center bg-canvas px-4 text-sm text-ink-muted">
        <div className="flex flex-col items-center gap-3 text-center">
          <p role="status" className="flex items-center gap-3"><span aria-hidden="true" className="h-3 w-3 motion-safe:animate-ping rounded-full bg-brand-500" />{opening === "wait" ? "Checking your account…" : "Opening sign-in…"}</p>
          {opening === "signin" && <Link href={signInHref(pathname)} className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-2">Go to sign in</Link>}
        </div>
      </main>
    );
  }
  if (opening === "welcome") return <PlannerContext value={ctx}><Welcome onCreate={createPlan} onSample={exploreSample} /></PlannerContext>;

  return (
    <PlannerContext value={ctx}>
    <div className="min-h-dvh w-full">
      {/* First stop for keyboard users: jump past the header and the page navigation straight to the page content. */}
      <a href="#main" className="sr-only rounded-lg bg-sand-900 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:px-4 focus:py-3">Skip to main content</a>
      <CommandBar
        plan={plan} today={today} setToday={setToday} insights={insights} activeTemplate={store.active}
        events={events}
        trash={trash} onDeleteEvent={slot => requestDelete(slot)} onRestore={id => { restoreEvent(id); }} onDeleteForever={requestDeleteForever}
        hideSamples={hideSamples} onToggleHideSamples={toggleHideSamples} onRestoreSamples={samplesMissing ? restoreSampleEvents : undefined} empty={noEvents}
        onLoadSamples={account && firstChoice !== "samples" ? loadSampleEvents : undefined}
        onSwitch={switchTemplate} onReset={resetTemplate} role={role} setRole={setRole}
        history={hist.snaps.map(s => s.label)} historyIdx={hist.idx} goTo={goTo} showInsight={showInsight}
        onExportCsv={exportCsv} onExportRunSheet={exportRunSheet} onShare={() => setShareOpen(true)} shared={!!shared.share}
        nav={!guest && wide && !noEvents ? <PageTabs current={onSetup ? null : currentPage.id} /> : null}
        onNewPlan={() => router.push(SETUP_PATH)}
        account={<AccountMenu cloud={cloud} onOpenChoice={() => setChoiceOpen(true)} onSignOut={f => void signOutAndLeave(f)} onLoadSamples={loadSampleEvents} />}
      />
      <CloudChoiceDialog open={choiceOpen && choicePending && !guest} status={cloud.status} localTitle={plan.event.title}
        onUseCloud={() => { setChoiceOpen(false); cloud.chooseCloud(); }} onKeepLocal={() => { setChoiceOpen(false); cloud.chooseLocal(); }}
        onClose={() => setChoiceOpen(false)} />
      <FirstChoiceDialog open={chooserOpen && !guest && !choicePending} name={cloud.user?.name ?? ""}
        onOwn={startOwnEvent} onSamples={loadSampleEvents} onClose={() => setChooserLater(true)} />
      <ConfirmDialog open={confirmState?.kind === "delete"} title={confirmState ? `Delete ${confirmState.title}?` : ""} cancelLabel="Cancel" testId="delete-dialog"
        onClose={() => { const c = confirmState; setConfirm(null); if (c?.kind === "delete") c.after?.(false); }}
        actions={[{ label: "Delete event", tone: "danger", testId: "delete-confirm", onClick: () => {
          const c = confirmState; setConfirm(null);
          if (c?.kind === "delete") { deleteEvent(c.slot); c.after?.(true); }
        } }]}>
        You can restore it for {TRASH_RETENTION_DAYS} days.
      </ConfirmDialog>
      <ConfirmDialog open={confirmState?.kind === "forever"} title={confirmState ? `Delete ${confirmState.title} forever?` : ""} cancelLabel="Cancel" testId="forever-dialog"
        onClose={() => setConfirm(null)}
        actions={[{ label: "Delete forever", tone: "danger", testId: "forever-confirm", onClick: () => { const c = confirmState; setConfirm(null); if (c?.kind === "forever") deleteForever(c.id); } }]}>
        This can&apos;t be undone. Its guest links stay switched off.
      </ConfirmDialog>
      <ConfirmDialog open={cloud.status.state === "choose_deleted" && !guest} testId="deleted-choice-dialog" onClose={() => {}} dismissible={false}
        title={cloud.status.state === "choose_deleted" && cloud.status.reason === "edited_elsewhere"
          ? `${cloud.status.cloud.plan.event.title} was edited on another device after you deleted it here`
          : `${plan.event.title} was deleted on another device`}
        actions={cloud.status.state === "choose_deleted" && cloud.status.reason === "edited_elsewhere"
          ? [{ label: "Keep deleted", tone: "neutral", testId: "deleted-keep", onClick: cloud.chooseKeepDeleted },
            { label: "Restore with those edits", tone: "primary", testId: "deleted-restore", onClick: cloud.chooseRestoreDeleted }]
          : [{ label: "Keep deleted", tone: "neutral", testId: "deleted-keep", onClick: cloud.chooseKeepDeleted },
            { label: "Restore with my edits", tone: "primary", testId: "deleted-restore", onClick: cloud.chooseRestoreDeleted }]}>
        {cloud.status.state === "choose_deleted" && cloud.status.reason === "edited_elsewhere"
          ? "Restore brings the event back with the other device's changes. Keep deleted leaves it in Recently deleted."
          : "This device has changes the cloud never saw. Restore keeps the event with your changes on every device; Keep deleted moves this copy to Recently deleted (restorable for 30 days)."}
      </ConfirmDialog>
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} share={shared.share} status={shared.status}
        onPublish={() => void shared.publish()} onSync={shared.syncNow} onForget={shared.forget} plan={plan} />
      {/* The page scrolls as one document. The bottom padding (--fab-space) keeps the last content clear of the floating
          Co-Pilot launcher; below 768px the organizer view also reserves room for the bottom tab bar and its safe-area inset. */}
      <main id="main" tabIndex={-1} data-testid="dashboard" data-page={guest ? "guest" : onSetup ? "setup" : currentPage.id}
        className={`min-w-0 px-3 pb-[calc(var(--fab-space)+env(safe-area-inset-bottom))] pt-4 focus-visible:outline-none sm:px-4 lg:px-6 lg:pt-6 ${guest ? "" : "max-md:pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--fab-space))]"}`}>
        {guest ? (
          <GuestMicrosite template={template} plan={plan} today={today} commit={commit} highlight={highlight} actingEntryId={actingEntryId} setActingEntryId={setActingGuest}
            summary={<KpiStrip kpis={kpisFor("guest", plan.event.eventType)} ctx={kpiCtx} guest />} />
        ) : children}
      </main>
      {/* Before the tab bar in the DOM, so the tab bar's "More" sheet paints over it when open. */}
      {!noEvents && <CopilotLauncher ref={launcherRef} open={copilotOpen} onOpen={() => setCopilotOpen(true)} title={copilotTitle} dialogId={copilotDialogId} guest={guest} aboveTabBar={!guest} />}
      {!guest && !wide && !noEvents && <PageTabBar current={onSetup ? null : currentPage.id} />}
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} titleId={copilotTitleId} dialogId={copilotDialogId} launcherRef={launcherRef}>
        <ChatSidebar
          messages={chats[role]} busy={busy} onSend={send} onApprove={(m, a) => approveAs(role, m, a)} onReject={(m, a) => rejectAs(role, m, a)} onScan={scan}
          mode={mode} forceOffline={forceOffline} setForceOffline={setForceOffline} plan={plan} role={role}
          actingEntryName={plan.rsvpEntries.find(e => e.id === actingEntryId)?.name ?? null}
          titleId={copilotTitleId} onClose={() => setCopilotOpen(false)} announcement={announcement}
          elsewhere={guest ? [] : linksTo(offPage)}
        />
      </CopilotDrawer>
      {/* Toasts sit above the bottom tab bar (and its safe-area inset) on small screens, so they never cover it or the last section,
          and stop short of the floating Co-Pilot launcher on the right. */}
      <div role="status" aria-live="polite"
        className={`pointer-events-none fixed left-3 right-[calc(5.25rem+env(safe-area-inset-right))] z-40 flex flex-col gap-2 sm:right-auto sm:max-w-md md:bottom-4 md:left-4 ${guest ? "bottom-[calc(1rem+env(safe-area-inset-bottom))]" : "bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]"}`}>
        {toasts.map(t => (
          <div key={t.id} className={`toast-in pointer-events-auto break-words rounded-xl px-4 py-3 text-sm shadow-lg ${t.tone === "emerald" ? "bg-emerald-700 text-white" : t.tone === "rose" ? "bg-red-700 text-white" : "bg-sand-800 text-white"}`}>
            {t.text}
            {t.action && (
              <button type="button" onClick={t.action.onClick} data-testid="toast-undo"
                className="ml-2 inline-flex min-h-8 items-center rounded-md border border-white/80 px-2.5 font-semibold text-white underline-offset-2 hover:bg-white/10 hover:underline">
                {t.action.label}
              </button>
            )}
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
