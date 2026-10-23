import type { Metadata } from "next";
import { EventPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("event").title) };

export default function Page() {
  return <EventPage />;
}
