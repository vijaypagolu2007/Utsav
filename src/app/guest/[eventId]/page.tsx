import type { Metadata } from "next";
import PublicGuestPage from "@/components/PublicGuestPage";

// Capability links must not be indexed or leak through Referer headers.
export const metadata: Metadata = { title: "You're invited · Utsav", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <PublicGuestPage eventId={eventId} />;
}
