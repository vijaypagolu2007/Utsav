import type { Metadata } from "next";
import { VendorsPage } from "@/components/PlannerPages";
import { pageById, pageTitle } from "@/routes";

export const metadata: Metadata = { title: pageTitle(pageById("vendors").title) };

export default function Page() {
  return <VendorsPage />;
}
