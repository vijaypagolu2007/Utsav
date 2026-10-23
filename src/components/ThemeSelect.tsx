"use client";
import { useId, useSyncExternalStore } from "react";
import { Moon, Monitor, Sun } from "lucide-react";
import { readThemePref, setThemePref, subscribeTheme, THEME_LABELS, THEME_PREFS, isThemePref, type ThemePref } from "@/theme";

const ICON: Record<ThemePref, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** Labelled Light / Dark / System select. The server snapshot is "system", the default for a first visit. */
export default function ThemeSelect({ className = "" }: { className?: string }) {
  const pref = useSyncExternalStore(subscribeTheme, readThemePref, () => "system" as ThemePref);
  const id = useId();
  const Icon = ICON[pref];
  return (
    <div className={className}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-ink"><Icon size={16} aria-hidden="true" /> Theme</label>
      <select id={id} value={pref} onChange={e => { if (isThemePref(e.target.value)) setThemePref(e.target.value); }} data-testid="theme-select"
        className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink">
        {THEME_PREFS.map(p => <option key={p} value={p}>{THEME_LABELS[p]}{p === "system" ? " (match device)" : ""}</option>)}
      </select>
    </div>
  );
}
