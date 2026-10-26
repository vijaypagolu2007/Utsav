import type { Metadata } from "next";
import JoinPage from "@/components/JoinPage";

// v8 Part 1: the group join link. Not indexed, and no Referer, so the token in the address can't leak to other sites.
export const metadata: Metadata = { title: "Join the guest list · Utsav", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <JoinPage eventId={eventId} />;
}
