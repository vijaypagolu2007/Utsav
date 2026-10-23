import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/theme";

export const metadata: Metadata = {
  title: "Utsav — GenAI Event Planning Co-Pilot",
  description: "Weddings, birthdays and community events on a live reactive canvas, with a Gemini co-pilot that never does the math itself.",
};

// viewport-fit=cover exposes the safe-area insets the drawer and launcher pad for; resizes-content lets the
// drawer (100dvh) shrink above the on-screen keyboard in Chromium browsers so the chat input stays visible.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The inline script sets data-theme before first paint (no light flash in dark mode). It changes <html>
    // attributes React didn't render, hence suppressHydrationWarning (it only covers this element's own attributes).
    <html lang="en-IN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head>
      <body className="bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
