import type { Metadata } from "next";
import { IdeasPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("ideas").title) };

export default function Page() {
  return <IdeasPage />;
}
