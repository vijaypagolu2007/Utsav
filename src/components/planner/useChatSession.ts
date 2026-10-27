"use client";
// The Co-Pilot conversation (one transcript per role), its busy flag and AI mode, and every call to /api/chat and
// /api/scan-quote: chat, "Get more ideas", "Questions to ask" and the quote scanner. Moved out of PlannerApp in v8
// Part 2, unchanged. Replies land through ingest → commitWith (Tier 0 auto-applies; everything else waits for Approve).
import { useRef, useState } from "react";
import type { AgentState, IdeaKind } from "@/schema";
import type { BatchInput, BatchResult, BatchSource, Role } from "@/commands";
import { runOfflineAgent, runOfflineGuestAgent, runOfflineIdeas, runOfflineVendorQuestions } from "@/offline";
import type { Refine } from "@/ideas";
import type { AgentAction, ChatResponse } from "@/agent";
import { sampleQuote, scanToActions, SAMPLE_QUOTES, type ScanResponse } from "@/quote-scanner";
import type { PlannerPage } from "@/routes";
import type { ChatMsg, UIAction } from "../ChatSidebar";
import { newId } from "./ids";
import type { ToastFn } from "./useToasts";
import type { IdeasResult, QuestionsResult, ScanInput } from "./types";

const nid = () => newId("m");

const WELCOME: Record<Role, ChatMsg> = {
  organizer: { id: "welcome", role: "assistant",
    text: "Hi! I plan with you, but every rupee and date goes through a deterministic engine: I propose, it computes, you approve. Ask for ideas, try a suggestion below, scan a vendor quote, or ask anything." },
  guest: { id: "welcome", role: "assistant",
    text: "Welcome! I'm your event concierge. Ask me about timings, venues and dress codes, or RSVP, set meal preferences, claim a gift or sign up to volunteer right here." },
};

type ChatDeps = {
  role: Role;
  setRole: (r: Role) => void;
  actingEntryId: string | null;
  today: string;
  current: () => AgentState;
  commitWith: (r: Role, batch: BatchInput, label?: string, source?: BatchSource) => BatchResult;
  toast: ToastFn;
  setAnnouncement: (text: string) => void;
  setElsewhere: (pages: PlannerPage[]) => void;
};

export function useChatSession({ role, setRole, actingEntryId, today, current, commitWith, toast, setAnnouncement, setElsewhere }: ChatDeps) {
  const [chats, setChats] = useState<Record<Role, ChatMsg[]>>({ organizer: [WELCOME.organizer], guest: [WELCOME.guest] });
  const chatsRef = useRef(chats);
  const [busy, setBusy] = useState(false);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [mode, setMode] = useState<"gemini" | "offline" | null>(null);
  const setMsgs = (r: Role, f: (m: ChatMsg[]) => ChatMsg[]) => { chatsRef.current = { ...chatsRef.current, [r]: f(chatsRef.current[r]) }; setChats(chatsRef.current); };

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

  return { chats, busy, ideasBusy, mode, setMode, forceOffline, setForceOffline, setAction, send, scan, requestIdeas, requestVendorQuestions };
}
