import type { Metadata } from "next";
import SignInPage from "@/components/SignInPage";
import { pageTitle } from "@/routes";

// Outside the (planner) group: the planner shell (and the local plan) never mounts here, so a locked plan stays hidden.
export const metadata: Metadata = { title: pageTitle("Sign in"), robots: { index: false, follow: false } };

export default function Page() {
  return <SignInPage />;
}
