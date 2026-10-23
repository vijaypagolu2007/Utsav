import type { Metadata } from "next";
import { BudgetPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("budget").title) };

export default function Page() {
  return <BudgetPage />;
}
