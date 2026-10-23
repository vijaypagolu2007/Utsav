import type { Metadata } from "next";
import { SchedulePage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("schedule").title) };

export default function Page() {
  return <SchedulePage />;
}
