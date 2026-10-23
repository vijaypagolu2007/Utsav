"use client";
// The shared, client-side plan state every organizer page reads. PlannerApp (rendered once by the (planner) layout)
// owns it, so it survives client navigation between /, /budget, /tasks, /schedule and /event without reloading.
import { createContext, useContext } from "react";
import type { AgentState } from "@/schema";
import type { Insight, PlanInsights } from "@/insights";
import type { Role } from "@/commands";
import type { EventTemplate } from "@/config/event-templates";
import type { Commit, CreatePlanResult, Highlight, IdeasResult, QuestionsResult, ScanInput } from "./PlannerApp";
import type { Refine } from "@/ideas";
import type { IdeaKind } from "@/schema";
import type { SetupInputRaw } from "@/setup";

export type PlannerState = {
  plan: AgentState;
  today: string;
  insights: PlanInsights;
  template: EventTemplate;
  role: Role;
  highlight: Highlight;
  busy: boolean;
  /** Every dashboard edit goes through here: the deterministic reducer, under the current role, source "ui". */
  commit: Commit;
  /** Pulse these ids for three seconds (the "what just changed" highlight). */
  flash: (ids: string[]) => void;
  /** "Show me" for a red flag: go to the page that owns it, highlight it and move focus to it. */
  showInsight: (i: Insight) => void;
  /** Dashboard actions whose answer lands in the chat (AI pitch, quote scan) open the Co-Pilot drawer first. */
  ask: (text: string) => void;
  scan: (input: ScanInput) => void;
  /** Setup form → a new plan (live Gemini when available, Demo Mode blueprint otherwise), loaded as the active plan. */
  createPlan: (setup: SetupInputRaw) => Promise<CreatePlanResult>;
  /** "Get more ideas" for the idea board. */
  requestIdeas: (focus: string, kind?: IdeaKind, refine?: Refine) => Promise<IdeasResult>;
  /** v6: "Questions to ask" one kind of vendor. */
  requestVendorQuestions: (need: string) => Promise<QuestionsResult>;
  ideasBusy: boolean;
  /** Which brain answered last (null until the first AI call). */
  aiMode: "gemini" | "offline" | null;
  forceOffline: boolean;
};

export const PlannerContext = createContext<PlannerState | null>(null);

export function usePlanner(): PlannerState {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error("usePlanner() must be used inside the planner layout (PlannerApp)");
  return ctx;
}
