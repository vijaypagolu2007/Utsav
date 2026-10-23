import type { Metadata } from "next";
import { OverviewPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("overview").title) };

export default function Page() {
  return <OverviewPage />;
}
