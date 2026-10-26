import type { Metadata } from "next";
import { GuestsPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("guests").title) };

export default function Page() {
  return <GuestsPage />;
}
