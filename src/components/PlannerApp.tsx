"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { AgentState } from "@/schema";
import type { Role } from "@/commands";
import { computePlanInsights, type Insight } from "@/insights";
import { budgetLedgerCsv, runSheetHtml } from "@/export";
import { type Store, flushStore, historyOf, isFirstRun, markOnboarded } from "@/persistence";
import { isTemplateId, presentationFor, slotFor, TEMPLATES, type TemplateId } from "@/config/event-templates";
import {
  hasMeaningfulLocalEdits, hasNoEvents, isOwnEvent, isPristineSample, loadFirstChoice, mayCreateCloudCopy, needsCloudProbe, sampleRemoved, saveFirstChoice,
  shouldShowFirstChoice, switcherSections, unmarkRemoved, type CloudPlans, type FirstChoice,
} from "@/my-events";
import { isSetupPath, pageForInsight, pageForPath, pageTitle, refAnchor, refFromHash, SETUP_PATH } from "@/routes";
import type { SetupInputRaw } from "@/setup";
import Welcome from "./Welcome";
import CommandBar from "./CommandBar";
import GuestMicrosite from "./GuestMicrosite";
import ChatSidebar, { type UIAction } from "./ChatSidebar";
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
import { decideOpening, forgetThisDevice, signInHref, signInSkipped, SIGNIN_PATH, wasSignedInOnDevice } from "@/signin";
import { PlannerContext, type PlannerState } from "./planner-context";
import ConfirmDialog from "./ConfirmDialog";
import { canDelete, loadHideSamples, restoreSamples as withSamplesRestored, saveHideSamples, samplesHidden, TRASH_RETENTION_DAYS } from "@/trash";
// v8 Part 2: the shell's state lives in focused hooks (src/components/planner/); this file wires them together.
import { afterPaint, download, focusTarget } from "./planner/dom";
import { linksTo, usePlanCommits, usePlanHistory } from "./planner/usePlanHistory";
import { ToastStack, useToasts } from "./planner/useToasts";
import { useChatSession } from "./planner/useChatSession";
import { useEventTrash, type DeletionBridge } from "./planner/useEventTrash";
import { useStableHandlers } from "./planner/useStableHandlers";
import type { CreatePlanResult, ScanInput } from "./planner/types";

export type { Commit, CreatePlanResult, Highlight, IdeasResult, QuestionsResult, ScanInput, Toast, ToastAction, ToastLink } from "./planner/types";

type SyncStatusKey = string | null;

/** v8 Part 0b: an untouched sample only gets a cloud copy once this account chose "Load sample events" (or edits it). */
const mayCreate = (account: string, planKey: string, p: AgentState) =>
  !isTemplateId(planKey) || mayCreateCloudCopy({ pristineSample: isPristineSample(planKey, p), choice: loadFirstChoice(account) });

/**
 * The organizer shell, rendered once by the (planner) layout around whichever page is open. It owns the plan state
 * (history, undo/redo, persistence), the Co-Pilot drawer, the share dialog, toasts and the page navigation, and hands
 * the plan to the pages through PlannerContext, so all of it survives client navigation. Guest View replaces the
 * page with the guest microsite and hides the organizer navigation.
 */
export default function PlannerApp({ children }: { children?: ReactNode }) {
  const { toasts, toast, dismissAction, announcement, setAnnouncement } = useToasts();
  const router = useRouter();
  const pathname = usePathname();
  // Read by handlers that finish after an await (a chat reply), so it must be the page open *then*, not at send time.
  const pathRef = useRef(pathname);
  useLayoutEffect(() => { pathRef.current = pathname; }, [pathname]);
  const currentPage = pageForPath(pathname);
  const onSetup = isSetupPath(pathname);
  const h = usePlanHistory(pathRef, toast);
  const { store, storeRef, setStore, setHist, today, setToday, hist, plan, current, highlight, flash, elsewhere, setElsewhere, push, switchTemplate, resetTemplate, goTo } = h;
  // A brand-new browser (no saved plans, welcome never answered) gets the welcome screen instead of a sample plan.
  const [firstRun, setFirstRun] = useState(() => isFirstRun());
  const [role, setRole] = useState<Role>("organizer");
  const [actingGuest, setActingGuest] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // The Co-Pilot drawer is closed by default; its chat state stays in useChatSession (and ChatSidebar) whether it is open or not.
  const [copilotOpen, setCopilotOpen] = useState(false);
  const copilotTitleId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);

  const insights = useMemo(() => computePlanInsights(plan, today), [plan, today]);
  const template = useMemo(() => presentationFor(store.active, plan), [store.active, plan]);
  // v8 Part 1c: in Guest View the preview acts as one RSVP entry (picked on its RSVP card, or the one it just sent).
  const actingEntryId = plan.rsvpEntries.some(e => e.id === actingGuest && !e.removedAt && !e.mergedInto) ? actingGuest : null;
  const { commitWith, commit, commitUndoable, loadPlan } = usePlanCommits(h, role, actingEntryId, toast, dismissAction);
  const { chats, busy, ideasBusy, mode, setMode, forceOffline, setForceOffline, setAction, send, scan, requestIdeas, requestVendorQuestions } =
    useChatSession({ role, setRole, actingEntryId, today, current, commitWith, toast, setAnnouncement, setElsewhere });

  // ---------- shared guest links (server copy kept in sync; guest responses merged back in) ----------
  const shared = useSharedEvent(store.active, plan, merged => { const off = push(merged, "Synced guest responses"); flushStore(); toast("slate", "Guest responses synced", linksTo(off)); });

  // ---------- optional Google sign-in: cloud copy of the active slot (local storage stays the working copy) ----------
  // "Use cloud copy" replaces the plan on screen like loading a plan: the cloud copy was validated by the server's schema
  // and again on arrival, it lands as one history step (so the device's plan is one Undo away), and nothing is merged.
  // v8 Part 0c: the deletion callbacks are defined further down (they use the share hook and the router); a ref bridges them.
  const deletionRef = useRef<DeletionBridge>({ onRemoteDelete: () => {}, onRestoreFromCloud: () => false });
  const cloud = useCloudSync(store.active, plan, cloudPlan => { const off = push(cloudPlan, "Loaded cloud copy"); flushStore(); toast("slate", "Loaded the cloud copy", linksTo(off)); }, mayCreate, {
    onRemoteDelete: (k, at) => deletionRef.current.onRemoteDelete(k, at),
    onRestoreFromCloud: (k, p) => deletionRef.current.onRestoreFromCloud(k, p),
    isPristine: (k, p) => isTemplateId(k) && isPristineSample(k, p),
    isRemoved: k => isTemplateId(k) && sampleRemoved(storeRef.current, k),
  });
  // ---------- v8: sign-in-first opening (decided client-side: this component never renders on the server or during hydration) ----------
  // Read once per mount; a sign-in seen while the planner is open counts as "signed in on this device" from then on
  // and ends this session's "without an account" choice (the same flags the sign-in page writes).
  const [device] = useState(() => ({ before: wasSignedInOnDevice(), skipped: signInSkipped() }));
  const [seenUser, setSeenUser] = useState(false);
  if (cloud.user && !seenUser) setSeenUser(true);
  const opening = decideOpening({ authReady: cloud.authReady, signedIn: !!cloud.user, previouslySignedIn: device.before || seenUser, skipped: device.skipped && !seenUser, firstRun });
  // Signed out on a device someone signed in on: the sign-in page first (it comes back here afterwards).
  // Replacing twice under Strict Mode's double effect lands on the same URL, so it is harmless.
  useEffect(() => { if (opening === "signin") { flushStore(); router.replace(signInHref(pathRef.current)); } }, [opening, router]);
  // Signed in on a brand-new browser: straight to the plan (decideOpening), and the welcome counts as answered.
  const signedIn = !!cloud.user;
  useEffect(() => { if (signedIn && firstRun) markOnboarded(); }, [signedIn, firstRun]);
  /** Sign out; "Also remove this plan from this device" clears this browser's plans first and reloads on /signin, so nothing stays in memory either. */
  const signOutAndLeave = async (removeFromDevice: boolean) => {
    // v8 Part 2: saves are debounced; write the pending one first, so nothing lands after the plans are removed.
    if (removeFromDevice) flushStore();
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
  // The per-account answer lives in localStorage; reading it during render is safe because this component only renders on the client, after hydration (ClientRoot).
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
      setStore(r.store, true);
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


  // ---------- v8 Part 0c: delete, Recently deleted, restore (useEventTrash) ----------
  const { trash, confirmState, setConfirm, requestDelete, requestDeleteForever, deleteForever, deleteEvent, restoreEvent } =
    useEventTrash({ storeRef, setStore, shared, cloud, account, firstChoice, flash, toast, dismissAction, router, pathRef, deletionRef });
  const ownCount = events.mine.length;
  // Samples can only be hidden while there is an event of the organizer's own ("Explore a sample" never disappears).
  const hideSamples: boolean | null = ownCount > 0 ? samplesHidden(hidePref, ownCount) : null;
  // v8 Part 0d: every event deleted (samples too). The setup form shows, with "Restore samples"; never a blank screen.
  const noEvents = events.mine.length === 0 && events.samples.length === 0;
  /** "Restore samples" in the event menu: some sample was deleted, or the samples are hidden. */
  const samplesMissing = events.removed.length > 0 || hideSamples === true;
  useEffect(() => { if (noEvents && opening === "plan" && !isSetupPath(pathRef.current)) router.replace(SETUP_PATH); }, [noEvents, opening, pathname, router]);

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
      flushStore();
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
    setStore(s, true);
    markOnboarded();
    setFirstRun(false);
    router.push("/");
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
  }, [pathname, flash]);

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
  // v8 Part 2: the context value only changes when what it shows changes (not on every toast or drawer toggle), and its
  // functions keep their identity: each is a stable handle onto this render's version.
  const handlers = useStableHandlers({ commit, commitUndoable, flash, showInsight, ask: askFromDashboard, scan: scanFromDashboard, createPlan, requestIdeas, requestVendorQuestions,
    requestDelete: () => requestDelete(storeRef.current.active), restoreSamples: restoreSampleEvents,
    publish: () => void shared.publish(), syncNow: shared.syncNow, resetInvite: shared.resetInvite, setJoinLink: shared.setJoinLink, resetRsvpLink: shared.resetRsvpLink,
    openShare: () => setShareOpen(true) });
  const ctx: PlannerState = useMemo(() => ({ plan, today, insights, template, role, highlight, busy, commit: handlers.commit, commitUndoable: handlers.commitUndoable,
    flash: handlers.flash, showInsight: handlers.showInsight, ask: handlers.ask, scan: handlers.scan,
    createPlan: handlers.createPlan, requestIdeas: handlers.requestIdeas, ideasBusy, aiMode: mode, forceOffline, requestVendorQuestions: handlers.requestVendorQuestions,
    eventActions: { requestDelete: handlers.requestDelete, noEvents, restoreSamples: handlers.restoreSamples },
    sharing: { share: shared.share, status: shared.status, publish: handlers.publish, syncNow: handlers.syncNow, resetInvite: handlers.resetInvite, setJoinLink: handlers.setJoinLink,
      resetRsvpLink: handlers.resetRsvpLink, openShare: handlers.openShare } }),
  [plan, today, insights, template, role, highlight, busy, ideasBusy, mode, forceOffline, noEvents, shared.share, shared.status, handlers]);
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
        className={`min-w-0 px-4 pb-[calc(var(--fab-space)+env(safe-area-inset-bottom))] pt-6 focus-visible:outline-none sm:px-6 lg:px-8 lg:pt-8 ${guest ? "" : "max-md:pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--fab-space))]"}`}>
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
      <ToastStack toasts={toasts} guest={guest} />
    </div>
    </PlannerContext>
  );
}
