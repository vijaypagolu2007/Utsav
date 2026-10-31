"use client";
import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { nextThemePref, readThemePref, setThemePref, subscribeTheme, themeToggleLabel, type ThemePref } from "@/theme";
import { IconButton } from "./ui";

const ICON: Record<ThemePref, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/**
 * Header theme toggle (v8 Part 3): one button, tap to cycle System, then Light, then Dark. The icon shows the current
 * choice, the accessible name says it and what a press switches to ("Theme: Dark. Switch to System"). IconButton gives
 * it the 44px touch target on coarse pointers and narrow screens. The server snapshot is "system", the first-visit default.
 */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const pref = useSyncExternalStore(subscribeTheme, readThemePref, () => "system" as ThemePref);
  const Icon = ICON[pref];
  return (
    <IconButton label={themeToggleLabel(pref)} onClick={() => setThemePref(nextThemePref(pref))} data-testid="theme-toggle" data-theme-pref={pref} className={className}>
      <Icon size={16} />
    </IconButton>
  );
}
