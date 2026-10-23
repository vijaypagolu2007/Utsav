import ClientRoot from "@/components/ClientRoot";

// Every organizer page (/, /budget, /tasks, /schedule, /event) renders inside this one layout, so the planner shell
// (plan state, undo history, Co-Pilot drawer, share dialog, toasts, navigation) stays mounted across client navigation.
// /guest/[eventId] and /api/* sit outside the (planner) group and are untouched by it.
export default function PlannerLayout({ children }: { children: React.ReactNode }) {
  return <ClientRoot>{children}</ClientRoot>;
}
