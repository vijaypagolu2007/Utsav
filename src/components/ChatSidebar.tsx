"use client";
import { useState } from "react";
import { AlertOctagon, AlertTriangle, ArrowRight, Bot, Check, Copy, FileText, Loader2, Mail, MessageCircle, Paperclip, Send, ShieldAlert, ShieldCheck, Sparkles, Ticket, Wand2, WifiOff, X } from "lucide-react";
import type { Role } from "@/commands";
import { SAMPLE_QUOTES } from "@/quote-scanner";
import type { ScanInput } from "./PlannerApp";
import type { AgentState } from "@/schema";
import type { AgentAction } from "@/agent";
import { TIER_LABEL } from "@/trust";
import { Badge, inr, severityTone } from "./ui";

export type UIAction = AgentAction & { status: "pending" | "applied" | "rejected" | "failed" | "loaded"; error?: string };
export type ChatMsg = { id: string; role: "user" | "assistant"; text: string; actions?: UIAction[]; mode?: "gemini" | "offline"; warning?: string };

type Props = {
  messages: ChatMsg[]; busy: boolean; onSend: (t: string) => void;
  onApprove: (msgId: string, a: UIAction) => void; onReject: (msgId: string, a: UIAction) => void;
  mode: "gemini" | "offline" | null; forceOffline: boolean; setForceOffline: (v: boolean) => void; plan: AgentState;
  onScan: (i: ScanInput) => void; role: Role; actingGuestName: string | null;
};

const GUEST_CHIPS: Record<string, string[]> = {
  wedding: ["What is the dress code and venue for Sangeet?", "RSVP yes for Anil Sharma to Haldi", "Mark the Sharma household as attending Haldi and Reception with 2 Jain meals", "Cut ₹20k from decor"],
  birthday: ["Which birthday wishes are still unclaimed?", "Claim the Retro Polaroid Camera from the birthday wishlist.", "What time does the party start and what should I wear?"],
  community: ["Sign Ravi Kumar up to volunteer for the Cultural Night", "Bright Ideas Pvt Ltd wants to sponsor at gold tier", "When is the Main Stage & Food Court?"],
};

export const JUDGE_CHIPS = [
  { text: "Cut ₹20k from decor and move the Haldi to Friday", hint: "slack-proportional cut + weekday resolve + cascade" },
  { text: "Cut ₹1.5L from decor", hint: "atomic rollback + self-healing counter-offer" },
  { text: "Move the Haldi to Monday", hint: "phase invariant rejection" },
  { text: "Which vendor deposits are overdue and what tasks are urgent?", hint: "proactive insights" },
  { text: "Switch to a 30th Retro Arcade Birthday for ₹1.5L", hint: "cold-start blueprint + ext polymorphism" },
];

function StatusPill({ a }: { a: UIAction }) {
  if (a.status === "applied") return <Badge tone="emerald"><Check size={11} /> Committed</Badge>;
  if (a.status === "loaded") return <Badge tone="emerald"><Check size={11} /> Loaded</Badge>;
  if (a.status === "rejected") return <Badge tone="slate"><X size={11} /> Rejected</Badge>;
  if (a.status === "failed") return <Badge tone="rose" title={a.error}><AlertOctagon size={11} /> Failed</Badge>;
  return null;
}

function DiffCard({ a, onApprove, onReject }: { a: Extract<UIAction, { kind: "batch" }>; onApprove: () => void; onReject: () => void }) {
  const pending = a.status === "pending";
  const isQuote = a.batch.commands.some(c => c.op === "upsert_vendor_quote");
  return (
    <div data-testid={a.counterOffer ? "counter-offer-card" : "diff-card"} className={`rounded-xl border ${a.tier === 0 ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/40"} p-3`}>
      <div className="flex items-center gap-2">
        {a.tier === 0 ? <ShieldCheck size={14} className="text-emerald-600" /> : <ShieldAlert size={14} className="text-amber-600" />}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Tier {a.tier} · {a.counterOffer ? "Counter-offer" : TIER_LABEL[a.tier]}</span>
        <span className="ml-auto"><StatusPill a={a} /></span>
      </div>
      <div className="mt-1 text-xs font-medium text-slate-800">{a.batch.summary}</div>
      {a.redFlags && a.redFlags.length > 0 && (
        <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2">
          <div className="flex items-center gap-1 text-[11px] font-semibold text-rose-700"><AlertTriangle size={12} /> Contract red flags{a.source === "gemini" ? " (read by Gemini Vision)" : ""}</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-rose-900">{a.redFlags.map(f => <li key={f}>{f.startsWith("⚠️") ? f : `⚠️ ${f}`}</li>)}</ul>
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {a.diff.rows.map((r, i) => (
          <li key={`${r.id}-${i}`} className="rounded-md bg-white px-2 py-1 text-[11px] ring-1 ring-slate-100">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{r.label}</span>
              {r.deltaPaise !== undefined && r.deltaPaise !== 0 && <span className={`tabular-nums font-semibold ${r.deltaPaise < 0 ? "text-rose-600" : "text-emerald-700"}`}>{r.deltaPaise < 0 ? "−" : "+"}{inr(Math.abs(r.deltaPaise))}</span>}
            </div>
            <div className="flex items-center gap-1 tabular-nums text-slate-500"><span className="line-through decoration-slate-300">{r.before}</span><ArrowRight size={10} /><span className="font-semibold text-slate-800">{r.after}</span></div>
            {r.note && <div className="text-[10px] text-sky-700">↳ {r.note}</div>}
          </li>
        ))}
        {a.diff.rows.length === 0 && <li className="text-[11px] text-slate-500">{a.log.join(" · ")}</li>}
      </ul>
      {a.diff.cascadedTasks > 0 && <div className="mt-1.5 text-[10px] text-sky-700">{a.diff.cascadedTasks} task due date{a.diff.cascadedTasks > 1 ? "s" : ""} cascaded</div>}
      {pending && a.tier > 0 && (
        <div className="mt-2 flex gap-2">
          <button onClick={onApprove} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-600 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"><Check size={13} /> {isQuote ? "Approve & Update Budget" : "Approve & Commit"}</button>
          <button onClick={onReject} className="flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><X size={13} /> Reject</button>
        </div>
      )}
      {a.status === "failed" && a.error && <div className="mt-1.5 text-[11px] text-rose-600">{a.error}</div>}
    </div>
  );
}

function RejectionCard({ a }: { a: Extract<UIAction, { kind: "rejection" }> }) {
  const d = a.rejection.diagnostics;
  const cut = Object.entries(d.categoryMaxCuttablePaise).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 6);
  return (
    <div data-testid="rejection-card" className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-rose-700"><AlertOctagon size={14} /> Rolled back · command #{a.rejection.failedCommandIndex + 1}</div>
      <div className="mt-1 text-xs text-slate-800">{a.rejection.reason}</div>
      {d.validDatesForSubEvent && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-500">Valid dates for {d.subEvent}</div>
          <div className="mt-1 flex flex-wrap gap-1">{d.validDatesForSubEvent.map(v => <Badge key={v} tone="emerald">{v}</Badge>)}</div>
        </div>
      )}
      {!d.validDatesForSubEvent && cut.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-500">Max cuttable now{d.lockedItems?.length ? ` (locked: ${d.lockedItems.join(", ")})` : ""}</div>
          <div className="mt-1 flex flex-wrap gap-1">{cut.map(([k, v]) => <Badge key={k} tone="slate">{k} {inr(v)}</Badge>)}</div>
        </div>
      )}
    </div>
  );
}

function DraftCard({ a }: { a: Extract<UIAction, { kind: "draft" }> }) {
  const [body, setBody] = useState(a.draft.body);
  const [copied, setCopied] = useState(false);
  const isMail = a.draft.channel === "email";
  const href = isMail
    ? `mailto:?subject=${encodeURIComponent(a.draft.subject ?? "")}&body=${encodeURIComponent(body)}`
    : `https://wa.me/?text=${encodeURIComponent(body)}`;
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
        {isMail ? <Mail size={14} /> : <MessageCircle size={14} />} Tier 2 · {TIER_LABEL[2]}
      </div>
      <div className="mt-1 text-xs text-slate-700">To <b>{a.draft.recipient}</b>{a.draft.subject && <> · <i>{a.draft.subject}</i></>}</div>
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={7}
        className="mt-2 w-full resize-y rounded-lg border border-violet-200 bg-white p-2 text-xs leading-relaxed text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-300" />
      <div className="mt-2 flex gap-2">
        <button onClick={() => { void navigator.clipboard?.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button>
        <a href={href} target="_blank" rel="noreferrer" className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">
          <Send size={13} /> Open in {isMail ? "mail" : "WhatsApp"}
        </a>
      </div>
    </div>
  );
}

function ActionView({ a, msgId, onApprove, onReject }: { a: UIAction; msgId: string; onApprove: Props["onApprove"]; onReject: Props["onReject"] }) {
  switch (a.kind) {
    case "batch": return <DiffCard a={a} onApprove={() => onApprove(msgId, a)} onReject={() => onReject(msgId, a)} />;
    case "rejection": return <RejectionCard a={a} />;
    case "draft": return <DraftCard a={a} />;
    case "insights": return (
      <div className="rounded-xl border border-slate-200 bg-white p-2">
        {a.insights.slice(0, 8).map(i => (
          <div key={i.id} className="flex items-start gap-2 p-1"><Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
            <span className="min-w-0 text-[11px]"><b className="font-medium text-slate-800">{i.title}</b> <span className="text-slate-500">· {i.detail}</span></span></div>
        ))}
        {a.insights.length === 0 && <p className="p-1 text-[11px] text-emerald-700">No red flags.</p>}
      </div>
    );
    case "init": return (
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-700"><Wand2 size={14} /> Cold-start blueprint<span className="ml-auto"><StatusPill a={a} /></span></div>
        <div className="mt-1 text-xs font-semibold text-slate-800">{a.plan.event.title}</div>
        <div className="text-[11px] text-slate-600">{a.plan.event.eventType} · {a.plan.event.city} · {a.plan.event.startDate}{a.plan.event.endDate !== a.plan.event.startDate ? ` → ${a.plan.event.endDate}` : ""} · {inr(a.plan.event.totalBudgetPaise)}</div>
        <div className="mt-2 flex flex-wrap gap-1">{a.plan.subEvents.map(s => <Badge key={s.id} tone={s.isMain ? "violet" : "slate"}>{s.name} · {s.date.slice(5)}</Badge>)}</div>
        <ul className="mt-2 grid grid-cols-2 gap-x-3 text-[11px] text-slate-600">
          {a.plan.budgetItems.slice(0, 8).map(b => <li key={b.id} className="flex justify-between gap-2"><span className="truncate">{b.label}</span><b className="tabular-nums">{inr(b.plannedPaise)}</b></li>)}
        </ul>
        <div className="mt-1 text-[10px] text-indigo-700">Σ {inr(a.plan.budgetItems.reduce((x, b) => x + b.plannedPaise, 0))}: exact to the paisa via largest remainder</div>
        {a.status === "pending" && <button onClick={() => onApprove(msgId, a)} className="mt-2 w-full rounded-lg bg-indigo-600 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">Load onto canvas</button>}
      </div>
    );
    case "init_rejection": return <div className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-700">{a.reason}</div>;
  }
}

export default function ChatSidebar({ messages, busy, onSend, onApprove, onReject, mode, forceOffline, setForceOffline, plan, onScan, role, actingGuestName }: Props) {
  const guest = role === "guest";
  const sample = SAMPLE_QUOTES.find(q => q.archetype === plan.event.eventType) ?? SAMPLE_QUOTES[0];
  const [input, setInput] = useState("");
  const submit = (t: string) => { if (!t.trim() || busy) return; onSend(t); setInput(""); };
  const extraChip = plan.event.ext.type === "community" ? "Draft a sponsor pitch for SpiceRoute Foods"
    : plan.event.ext.type === "birthday" ? "What's overdue and which wishes are unclaimed?" : "Draft a WhatsApp to negotiate the photographer's quote";

  return (
    <aside className="flex w-[30%] min-w-[340px] max-w-[520px] flex-col border-l border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <div className={`grid h-8 w-8 place-items-center rounded-lg text-white ${guest ? "bg-violet-600" : "bg-slate-900"}`}>{guest ? <Ticket size={16} /> : <Bot size={16} />}</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">{guest ? "Guest Concierge" : "AI Co-Pilot"}</div>
          <div className="text-[10px] text-slate-500">{guest ? `Read-only + RSVP assistant${actingGuestName ? ` · you are ${actingGuestName}` : ""}` : "Gemini proposes · reducer computes · you approve"}</div>
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600" title="Force the deterministic offline parser (for flaky Wi-Fi)">
          <input type="checkbox" checked={forceOffline} onChange={e => setForceOffline(e.target.checked)} className="accent-slate-800" />
          <WifiOff size={12} /> Demo mode
        </label>
        {mode && <span data-testid="ai-mode"><Badge tone={mode === "gemini" ? "emerald" : "slate"}>{mode === "gemini" ? "Gemini" : "Offline"}</Badge></span>}
      </header>

      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map(m => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={m.role === "user" ? "max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-3 py-2 text-sm text-white" : "space-y-2"}>
              {m.role === "assistant" ? (
                <>
                  <div className="flex gap-2">
                    <Sparkles size={14} className="mt-1 shrink-0 text-violet-500" />
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{m.text}</p>
                  </div>
                  {m.warning && <p className="ml-6 rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-800 ring-1 ring-amber-200">{m.warning}</p>}
                  {m.actions?.map(a => <div key={a.id} className="ml-6"><ActionView a={a} msgId={m.id} onApprove={onApprove} onReject={onReject} /></div>)}
                </>
              ) : m.text}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> Thinking…</div>}
      </div>

      <div className="border-t border-slate-200 p-3">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {guest ? "Try as a guest" : "Judge demo prompts"}
          {!guest && (
            <span className="ml-auto flex gap-1 normal-case tracking-normal">
              <button onClick={() => onScan({ sampleId: sample.id })} disabled={busy} title={sample.title}
                className="flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"><FileText size={11} /> Scan sample quote</button>
              <label className={`flex cursor-pointer items-center gap-1 rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50 ${busy ? "pointer-events-none opacity-50" : ""}`}>
                <Paperclip size={11} /> Upload
                <input type="file" accept="image/*,application/pdf,text/plain" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onScan({ file: f }); e.target.value = ""; }} />
              </label>
            </span>
          )}
        </div>
        <div className="mb-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
          {(guest ? (GUEST_CHIPS[plan.event.eventType] ?? []).map(text => ({ text, hint: "guest-safe" })) : [...JUDGE_CHIPS, { text: extraChip, hint: "Tier 2 outbound draft" }]).map(c => (
            <button key={c.text} onClick={() => submit(c.text)} disabled={busy} title={c.hint}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-left text-[11px] text-slate-700 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50">{c.text}</button>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); submit(input); }} className="flex gap-2">
          <input aria-label="Chat message" value={input} onChange={e => setInput(e.target.value)} placeholder={guest ? "Ask about timings, RSVP, claim a gift…" : "Ask, cut, move, plan, draft…"}
            className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400" />
          <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="rounded-xl bg-slate-900 px-3 text-white disabled:opacity-40"><Send size={16} /></button>
        </form>
      </div>
    </aside>
  );
}
