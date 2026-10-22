"use client";
import { useId, useRef, useState } from "react";
import type { AgentState } from "@/schema";
import { applyBatch, type BatchInput, type BatchResult, type Role } from "@/commands";
import { computePlanDiff } from "@/diff";
import { computePlanInsights, todayIST } from "@/insights";
import { runOfflineAgent, runOfflineGuestAgent } from "@/offline";
import type { AgentAction, ChatResponse } from "@/agent";
import { sampleQuote, scanToActions, SAMPLE_QUOTES, type ScanResponse } from "@/quote-scanner";
import { budgetLedgerCsv, runSheetHtml } from "@/export";
import { type History, type Store, freshHistory, historyOf, loadStore, saveStore, storedTitles } from "@/persistence";
import { defaultTemplateFor, presentationFor, requireTemplate, slotFor, templateLabel, type TemplateId } from "@/config/event-templates";
import CommandBar from "./CommandBar";
import BudgetCard from "./BudgetCard";
import TimelineCard from "./TimelineCard";
import TaskCard from "./TaskCard";
import ArchetypeCard from "./ArchetypeCard";
import GuestMicrosite from "./GuestMicrosite";
import ChatSidebar, { type ChatMsg, type UIAction } from "./ChatSidebar";
import CopilotDrawer from "./CopilotDrawer";
import { publicCount } from "@/visibility";
import ShareDialog from "./ShareDialog";
import { useSharedEvent } from "./useSharedEvent";

export type Highlight = { ids: Set<string>; key: number };
export type Toast = { id: number; tone: "emerald" | "rose" | "slate"; text: string };
export type Commit = (batch: BatchInput, label?: string) => BatchResult;
export type ScanInput = { sampleId: string } | { file: File };

let uid = 0;
const nid = () => `m${++uid}`;

const WELCOME: Record<Role, ChatMsg> = {
  organizer: { id: "welcome", role: "assistant",
    text: "Hi! I plan with you, but every rupee and date goes through a deterministic engine: I propose, it computes, you approve. Try a judge chip, scan a vendor quote, or ask anything." },
  guest: { id: "welcome", role: "assistant",
    text: "Welcome! I'm your event concierge. Ask me about timings, venues and dress codes, or RSVP, set meal preferences, claim a gift or sign up to volunteer right here." },
};

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PlannerApp() {
  const [store, setStoreState] = useState<Store>(() => loadStore());
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
  const copilotTitleId = useId();

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

  const toast = (tone: Toast["tone"], text: string) => {
    const id = ++uid;
    setToasts(t => [...t.slice(-3), { id, tone, text }]);
    setAnnouncement(text);
    // Errors stay up longer so there is time to read them (WCAG 2.2.1); every toast is also in a polite live region.
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === "rose" ? 9000 : 4500);
  };
  const flash = (ids: string[]) => {
    const key = Date.now();
    setHighlight({ ids: new Set(ids), key });
    setTimeout(() => setHighlight(h => (h.key === key ? { ids: new Set(), key } : h)), 3100);
  };
  const push = (next: AgentState, label: string) => {
    const t = slotFor(storeRef.current.active, next);
    const h = historyOf(storeRef.current, t);
    const before = h.snaps[h.idx]!.plan;
    setHist({ snaps: [...h.snaps.slice(0, h.idx + 1), { plan: next, label }].slice(-50), idx: Math.min(h.idx + 1, 49) }, t);
    flash(computePlanDiff(before, next).changedIds);
  };

  /** The only way the canvas changes: through the deterministic reducer, under the current role. */
  const commitWith = (r: Role, batch: BatchInput, label?: string): BatchResult => {
    const res = applyBatch(current(), batch, { role: r });
    if (res.ok) { push(res.state, label ?? batch.summary); toast("emerald", `Applied: ${res.log.join(" · ") || batch.summary}`); }
    else toast("rose", `Not applied: ${res.reason}`);
    return res;
  };
  const commit: Commit = (batch, label) => commitWith(role, batch, label);
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
    flash(computePlanDiff(before, after).changedIds);
  };

  // ---------- shared guest links (server copy kept in sync; guest responses merged back in) ----------
  const shared = useSharedEvent(store.active, plan, merged => { push(merged, "Synced guest responses"); toast("slate", "Guest responses synced"); });

  // ---------- chat ----------
  const setAction = (r: Role, msgId: string, actionId: string, patch: Partial<UIAction>) =>
    setMsgs(r, ms => ms.map(m => (m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => (a.id === actionId ? ({ ...a, ...patch } as UIAction) : a)) })));

  const ingest = (r: Role, res: Pick<ChatResponse, "reply" | "actions" | "warning"> & { mode?: ChatResponse["mode"] }, msgId: string) => {
    const ui: UIAction[] = res.actions.map((a: AgentAction) => ({ ...a, status: "pending" }) as UIAction);
    setMsgs(r, ms => [...ms, { id: msgId, role: "assistant", text: res.reply, actions: ui, mode: res.mode, warning: res.warning }]);
    if (res.mode) setMode(res.mode);
    for (const a of ui) {
      if (a.kind === "batch" && a.tier === 0) {
        const out = commitWith(r, a.batch, `${r === "guest" ? "Guest" : "AI"}: ${a.batch.summary}`);
        setAction(r, msgId, a.id, out.ok ? { status: "applied" } : { status: "failed", error: out.reason });
      }
    }
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const r = role;
    if (r === "organizer" && /haldi/i.test(t) && !current().subEvents.some(s => s.slug === "haldi")) {
      // The judge prompts that mention the Haldi are written for the wedding template: jump there instead of failing.
      const wedding = defaultTemplateFor("wedding");
      switchTemplate(wedding.id as TemplateId);
      if (!current().subEvents.some(s => s.slug === "haldi")) resetTemplate();
      toast("slate", `Switched to the ${wedding.name} for this prompt`);
    }
    setMsgs(r, ms => [...ms, { id: nid(), role: "user", text: t }]);
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

  return (
    <div className="flex min-h-dvh w-full flex-col lg:h-dvh lg:overflow-hidden">
      <CommandBar
        plan={plan} today={today} setToday={setToday} insights={insights} activeTemplate={store.active} template={template}
        storedTitles={storedTitles(store)}
        onSwitch={switchTemplate} onReset={resetTemplate} role={role} setRole={setRole}
        history={hist.snaps.map(s => s.label)} historyIdx={hist.idx} goTo={goTo} flash={flash}
        onExportCsv={exportCsv} onExportRunSheet={exportRunSheet} onShare={() => setShareOpen(true)} shared={!!shared.share}
      />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} share={shared.share} status={shared.status}
        onPublish={() => void shared.publish()} onSync={shared.syncNow} onForget={shared.forget} visibility={publicCount(plan)} />
      {/* Full width: the Co-Pilot is an overlay, so nothing here reflows when it opens. Bottom padding keeps the launcher off the last card. */}
      <main className="scroll-thin min-w-0 flex-1 p-3 pb-24 sm:p-4 sm:pb-24 lg:min-h-0 lg:overflow-y-auto" data-testid="dashboard">
        {role === "guest" ? (
          <GuestMicrosite template={template} plan={plan} today={today} commit={commit} highlight={highlight} actingGuestId={actingGuestId} setActingGuestId={setActingGuest} />
        ) : (
          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-12">
            <div className="min-w-0 2xl:col-span-7"><BudgetCard plan={plan} today={today} commit={commit} highlight={highlight} onScan={scanFromDashboard} busy={busy} /></div>
            <div className="min-w-0 2xl:col-span-5"><TaskCard plan={plan} today={today} commit={commit} highlight={highlight} /></div>
            <div className="min-w-0 2xl:col-span-12"><TimelineCard plan={plan} commit={commit} highlight={highlight} /></div>
            <div className="min-w-0 2xl:col-span-12"><ArchetypeCard template={template} plan={plan} today={today} commit={commit} highlight={highlight} onAsk={askFromDashboard} /></div>
          </div>
        )}
      </main>
      <CopilotDrawer open={copilotOpen} onOpen={() => setCopilotOpen(true)} onClose={() => setCopilotOpen(false)} title={copilotTitle} titleId={copilotTitleId} guest={role === "guest"}>
        <ChatSidebar
          messages={chats[role]} busy={busy} onSend={send} onApprove={(m, a) => approveAs(role, m, a)} onReject={(m, a) => rejectAs(role, m, a)} onScan={scan}
          mode={mode} forceOffline={forceOffline} setForceOffline={setForceOffline} plan={plan} role={role}
          actingGuestName={plan.guests.find(g => g.id === actingGuestId)?.name ?? null}
          titleId={copilotTitleId} onClose={() => setCopilotOpen(false)} announcement={announcement}
        />
      </CopilotDrawer>
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 right-20 z-40 flex flex-col gap-2 sm:right-auto sm:max-w-md">
        {toasts.map(t => (
          <div key={t.id} className={`toast-in pointer-events-auto break-words rounded-xl px-4 py-2.5 text-sm shadow-lg ${t.tone === "emerald" ? "bg-emerald-700 text-white" : t.tone === "rose" ? "bg-rose-700 text-white" : "bg-slate-800 text-white"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
