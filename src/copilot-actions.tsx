"use client";
// CopilotKit frontend actions (@copilotkit/react-core v1.x). An alternative wiring to the /api/chat Gemini route:
// the same reducer and the same deterministic trust tiers, run client-side. Tier 0 commits on the spot, Tier 1
// renders a Before → After diff and waits for Approve/Reject (renderAndWaitForResponse), Tier 2 renders a draft.
import { useEffect, useRef } from "react";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { applyBatch, Batch, derive } from "./commands";
import { computePlanDiff } from "./diff";
import { computePlanInsights } from "./insights";
import { batchTier } from "./trust";
import type { AgentState } from "./schema";

type Respond = (result: unknown) => void;

/** Tier 0 auto-applies once (even under StrictMode double effects) and reports back to the agent. */
function AutoApply({ run, respond }: { run: () => string; respond?: Respond }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !respond) return;
    done.current = true;
    respond(run());
  }, [run, respond]);
  return <div className="text-xs text-emerald-700">Auto-applied (Tier 0)</div>;
}

export function usePlannerCopilot(state: AgentState, setState: (s: AgentState) => void, today: string) {
  useCopilotReadable({ description: "Current event plan (amounts in paise)", value: state });
  useCopilotReadable({ description: "Derived: headroom, overdue payments, tasks due within 7 days", value: derive(state, today) });
  useCopilotReadable({ description: "Deterministic red flags (overdue deposits, envelope breaches, urgent tasks, archetype alerts)", value: computePlanInsights(state, today).insights });

  useCopilotAction({
    name: "apply_plan_changes",
    description:
      "Atomically apply every change from one user request. Weekdays are resolved by the tool. Amounts are in paise; a cut is negative. " +
      "Changes ≥ ₹25,000, date moves and payments wait for the user's approval; on rejection you get diagnostics and a counter-offer.",
    parameters: [
      { name: "summary", type: "string", description: "One-line echo of the change", required: true },
      {
        name: "commands", type: "object[]", required: true,
        description: "Ordered list of commands",
        attributes: [
          { name: "op", type: "string", enum: ["adjust_budget", "move_sub_event", "shift_block", "set_task_status", "record_payment", "set_rsvp",
            "set_item_lock", "claim_wishlist_item", "set_permit_status", "update_sponsor", "upsert_vendor_quote", "set_guest_diet", "community_signup"], required: true },
          { name: "category", type: "string", description: "adjust_budget: venue|catering|decor|photo_video|music|attire|beauty|stationery|gifts|logistics|permits|entertainment|misc" },
          { name: "subEvent", type: "string", description: "Sub-event slug, e.g. 'haldi'" },
          { name: "deltaPaise", type: "number", description: "adjust_budget: -2000000 = cut ₹20,000" },
          { name: "reason", type: "string" },
          { name: "to", type: "object", description: "move_sub_event: {weekday:'friday'} or {date:'2027-01-15'}",
            attributes: [{ name: "weekday", type: "string" }, { name: "date", type: "string" }, { name: "relativeTo", type: "string", enum: ["current_date", "main_event"] }] },
          { name: "newStartMin", type: "number", description: "Minutes from midnight; leave out to keep the time" },
          { name: "blockId", type: "string" }, { name: "taskId", type: "string" }, { name: "status", type: "string" },
          { name: "budgetItemId", type: "string" }, { name: "paymentId", type: "string" }, { name: "paidDate", type: "string" },
          { name: "guestId", type: "string" }, { name: "answer", type: "string" }, { name: "locked", type: "boolean" },
          { name: "itemId", type: "string" }, { name: "permitId", type: "string" }, { name: "referenceNo", type: "string" },
          { name: "sponsorId", type: "string" }, { name: "receivedPaise", type: "number" },
          { name: "vendorName", type: "string" }, { name: "itemLabel", type: "string" }, { name: "quotedPaise", type: "number" },
          { name: "depositRequiredPaise", type: "number" }, { name: "dueAt", type: "string" }, { name: "notes", type: "string" },
          { name: "lockItem", type: "boolean" }, { name: "diet", type: "string[]" }, { name: "kind", type: "string", enum: ["volunteer", "sponsor"] },
          { name: "name", type: "string" }, { name: "shift", type: "string" }, { name: "tier", type: "string" },
        ],
      },
    ],
    renderAndWaitForResponse: ({ args, status, respond }) => {
      if (status === "inProgress") return <div className="text-xs text-slate-500">Preparing changes…</div>;
      const preview = applyBatch(state, args); // dry run: pure, so the preview IS the reducer
      if (!preview.ok) {
        if (status === "executing" && respond) respond({ ok: false, reason: preview.reason, failedCommandIndex: preview.failedCommandIndex, diagnostics: preview.diagnostics, counterOffer: preview.suggestion ?? null });
        return <div className="text-xs text-rose-700">Rolled back: {preview.reason}</div>;
      }
      const tier = batchTier(Batch.parse(args).commands);
      const commitNow = () => { const r = applyBatch(state, args); if (r.ok) setState(r.state); return r.ok ? `Applied: ${r.log.join("; ")}` : `Not applied: ${r.reason}`; };
      if (tier === 0) return status === "executing" ? <AutoApply run={commitNow} respond={respond} /> : <div className="text-xs text-emerald-700">Applied</div>;
      const diff = computePlanDiff(state, preview.state);
      return (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
          <div className="font-semibold">Tier {tier} · needs approval: {String(args.summary ?? "")}</div>
          <ul className="mt-1 space-y-0.5">{diff.rows.map((r, i) => <li key={i}>{r.label}: {r.before} → <b>{r.after}</b></li>)}</ul>
          {status === "executing" && respond && (
            <div className="mt-2 flex gap-2">
              <button className="rounded bg-emerald-600 px-2 py-1 text-white" onClick={() => respond(commitNow())}>Approve &amp; Commit</button>
              <button className="rounded border px-2 py-1" onClick={() => respond("User rejected the change. Nothing was applied.")}>Reject</button>
            </div>
          )}
        </div>
      );
    },
  });

  useCopilotAction({
    name: "draft_outbound_message",
    description: "Tier 2: draft a WhatsApp/email to a vendor, sponsor or guests. The user edits and sends it; never claim it was sent.",
    parameters: [
      { name: "channel", type: "string", enum: ["whatsapp", "email"], required: true },
      { name: "recipient", type: "string", required: true },
      { name: "subject", type: "string" },
      { name: "body", type: "string", required: true },
    ],
    render: ({ args }) => (
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs">
        <div className="font-semibold">Draft to {args.recipient} ({args.channel})</div>
        <pre className="mt-1 whitespace-pre-wrap font-sans">{args.body}</pre>
      </div>
    ),
    handler: async () => "Draft shown to the user. They will send it themselves.",
  });
}
// With a LangGraph CoAgent instead, run applyBatch inside the graph node and sync via useCoAgent({ name: "planner", initialState }).
