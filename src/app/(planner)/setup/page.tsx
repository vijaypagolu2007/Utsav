import type { Metadata } from "next";
import { SetupPage } from "@/components/PlannerPages";
import { pageTitle, SETUP_TITLE } from "@/routes";

export const metadata: Metadata = { title: pageTitle(SETUP_TITLE) };

export default function Page() {
  return <SetupPage />;
}
