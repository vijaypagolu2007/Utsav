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
import type { ShareInfo, ShareStatus } from "./useSharedEvent";

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
  /** v8 Part 1e: the same, with an Undo button on its toast for 10 s (used when removing a run-sheet row). */
  commitUndoable: Commit;
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
  /**
   * The Overview hero's "Delete event" for every event, samples included (requestDelete opens the confirm dialog). A
   * sample is reset from the More menu's Reset (v8 Part 3b dropped the Overview's own "Reset sample"). noEvents: every
   * event is deleted, so the setup form offers restoreSamples ("Restore samples") as well as a new event.
   */
  eventActions: { requestDelete: () => void; noEvents: boolean; restoreSamples: () => void };
  /**
   * v8 Part 1: the shared guest links, for the Guests page. share is null until the organizer publishes. resetInvite and
   * setJoinLink resolve to an error message, or null when the server did it.
   */
  sharing: {
    share: ShareInfo | null; status: ShareStatus; publish: () => void; syncNow: () => void; openShare: () => void;
    resetInvite: (householdId: string) => Promise<string | null>;
    setJoinLink: (action: "enable" | "rotate" | "disable") => Promise<string | null>;
    /** v8 Part 1c: a new RSVP link for the event (the old one and its QR stop working; RSVPs already sent stay). */
    resetRsvpLink: () => Promise<string | null>;
  };
};

export const PlannerContext = createContext<PlannerState | null>(null);

export function usePlanner(): PlannerState {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error("usePlanner() must be used inside the planner layout (PlannerApp)");
  return ctx;
}
