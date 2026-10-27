// Types the planner shell hands to its pages (re-exported from PlannerApp, where the pages import them).
import type { BatchInput, BatchResult } from "@/commands";

export type Highlight = { ids: Set<string>; key: number };
/** A link in a toast: "changed on another page" after an AI edit, undo or sync. */
export type ToastLink = { href: string; label: string };
/** v8 Part 0c: a button in a toast ("Undo" after a delete). */
export type ToastAction = { label: string; onClick: () => void; testId: string };
export type Toast = { id: string; tone: "emerald" | "rose" | "slate"; text: string; links?: ToastLink[]; action?: ToastAction };
export type Commit = (batch: BatchInput, label?: string) => BatchResult;
export type ScanInput = { sampleId: string } | { file: File };
/** What creating a plan from the setup form returned: the plan is already loaded when ok. */
export type CreatePlanResult = { ok: true; mode: "gemini" | "offline"; warning?: string } | { ok: false; error: string; issues?: string[] };
/** What "Get more ideas" returned (the cards are already on the board when ok). */
export type IdeasResult = { ok: true; mode: "gemini" | "offline"; added: number; reply: string; warning?: string } | { ok: false; error: string };
/** v6: "Questions to ask" one kind of vendor (nothing in the plan changes). */
export type QuestionsResult = { ok: true; mode: "gemini" | "offline"; label: string; questions: string[]; warning?: string } | { ok: false; error: string };
