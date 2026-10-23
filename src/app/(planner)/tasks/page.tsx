import type { Metadata } from "next";
import { TasksPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("tasks").title) };

export default function Page() {
  return <TasksPage />;
}
