"use client";
// v8 Part 1b: the RSVP link's QR code, drawn by the in-repo encoder (src/qr.ts) as one SVG path. Always dark modules on a
// white tile with a 4-module quiet zone, in both themes, because phone cameras need that contrast. role="img" with an
// accessible name; the link itself is always shown as text next to it (the QR is never the only way to get it).
import { useMemo } from "react";
import { encodeQr, qrSvg, qrSvgPath } from "@/qr";

const QUIET = 4;

export default function QrImage({ value, label, describedBy, testId, className }: { value: string; label: string; describedBy?: string; testId?: string; className?: string }) {
  const m = useMemo(() => { try { return encodeQr(value); } catch { return null; } }, [value]);
  if (!m) return <p className="text-sm text-ink-muted" data-testid={testId}>This link is too long for a QR code. Share the link text instead.</p>;
  const dim = m.size + QUIET * 2;
  return (
    <svg viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} aria-describedby={describedBy} data-testid={testId} data-qr-version={m.version}
      shapeRendering="crispEdges" className={className}>
      <title>{label}</title>
      <rect width={dim} height={dim} className="fill-white" />
      <path d={qrSvgPath(m, QUIET)} className="fill-black" />
    </svg>
  );
}

function save(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

/** Download the QR as an SVG file (sharp at any print size). */
export function downloadQrSvg(value: string, title: string, filename: string) {
  const url = URL.createObjectURL(new Blob([qrSvg(value, title)], { type: "image/svg+xml" }));
  save(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download the QR as a PNG (for apps that don't take SVG): the same SVG drawn onto a canvas, 10 px per module. */
export async function downloadQrPng(value: string, title: string, filename: string): Promise<boolean> {
  const svg = qrSvg(value, title, 10);
  const img = new Image();
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const loaded = await new Promise<boolean>(resolve => { img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = src; });
  if (!loaded) return false;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width; canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  save(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
