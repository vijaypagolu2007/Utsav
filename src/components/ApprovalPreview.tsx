"use client";
// An approval card on the page itself (the same card the Co-Pilot shows): a pure dry run of the batch through the
// reducer, its before → after diff and trust tier, and Approve & Commit / Reject. Nothing changes until Approve.
import { useEffect, useRef, type ReactNode } from "react";
import { AlertOctagon, X } from "lucide-react";
import type { AgentState } from "@/schema";
import { applyBatch, Batch, type BatchInput } from "@/commands";
import { computePlanDiff } from "@/diff";
import { batchTier, type TrustTier } from "@/trust";
import { DiffCard, type UIAction } from "./ChatSidebar";

export default function ApprovalPreview({ plan, batch, onApprove, onCancel, label, testId = "approval-preview", explain, children }: {
  plan: AgentState; batch: BatchInput; onApprove: () => void; onCancel: () => void;
  /** Names the review region ("Review: rebalance to your total"). */
  label: string; testId?: string;
  /** v6: plain-English trade-offs and consequences, computed by code, shown on the card. */
  explain?: string[];
  /** v6: anything to show above the card (an over-budget warning with its own action). */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const r = applyBatch(plan, batch, { source: "ui" });
  return (
    <div ref={box} tabIndex={-1} role="group" aria-label={label} data-testid={testId} className="rounded-xl focus-visible:outline-offset-4">
      {children}
      {r.ok ? (
        <DiffCard a={{ kind: "batch", id: "preview", batch, status: "pending", log: r.log, diff: computePlanDiff(plan, r.state), explain,
          tier: Math.max(1, batchTier(Batch.parse(batch).commands)) as TrustTier } as UIAction & { kind: "batch" }} onApprove={onApprove} onReject={onCancel} />
      ) : (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="flex items-center gap-1.5 font-semibold"><AlertOctagon size={15} aria-hidden="true" />This change can’t be made</p>
          <p className="mt-1">{r.reason}</p>
          <button type="button" onClick={onCancel} className="mt-2 flex min-h-10 items-center gap-1 rounded-lg border border-sand-500 bg-white px-3 text-sm font-medium text-sand-800 hover:bg-sand-100"><X size={14} aria-hidden="true" />Close</button>
        </div>
      )}
    </div>
  );
}
