import type { NextConfig } from "next";

// Conservative security headers that don't break Next's inline bootstrap scripts. A strict nonce-based CSP is a
// documented follow-up (see README → Security), not enabled blindly here.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // same-origin-allow-popups (not same-origin): the optional Google sign-in uses Firebase's signInWithPopup, which needs
  // to keep a handle on the popup window it opens. Still isolates this page from any other opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // v8 Part 1: /guests is a page of its own now (it used to redirect to /event).
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
      { source: "/guest/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
