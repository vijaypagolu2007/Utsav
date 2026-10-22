import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Utsav — GenAI Event Planning Co-Pilot",
  description: "Weddings, birthdays and community events on a live reactive canvas, with a Gemini co-pilot that never does the math itself.",
};

// viewport-fit=cover exposes the safe-area insets the drawer and launcher pad for; resizes-content lets the
// drawer (100dvh) shrink above the on-screen keyboard in Chromium browsers so the chat input stays visible.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
