import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Utsav — GenAI Event Planning Co-Pilot",
  description: "Weddings, birthdays and community events on a live reactive canvas, with a Gemini co-pilot that never does the math itself.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
