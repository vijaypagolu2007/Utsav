// Light / Dark / System colour theme. Kept apart from the plan's own persistence (persistence.ts): one string in
// localStorage["utsav_theme_v1"], applied as data-theme="light" | "dark" on <html> (globals.css re-points the tokens).
// The same logic runs twice: as an inline script in <head> (layout.tsx) so the first paint is already right, and
// here for the toggle. System follows prefers-color-scheme and keeps following it while the page is open.

export const THEME_KEY = "utsav_theme_v1";
export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export const THEME_LABELS: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };
export const isThemePref = (v: unknown): v is ThemePref => typeof v === "string" && (THEME_PREFS as readonly string[]).includes(v);

const QUERY = "(prefers-color-scheme: dark)";

/**
 * Inline <head> script: no imports, no globals beyond window.__utsavTheme (a re-apply hook). It also re-applies when
 * the OS theme changes (System) or another tab changes the preference. Anything unexpected in storage means System.
 */
export const THEME_BOOT_SCRIPT = `(function(){var k=${JSON.stringify(THEME_KEY)},d=document.documentElement,m=window.matchMedia?window.matchMedia(${JSON.stringify(QUERY)}):null;function a(){var p=null;try{p=window.localStorage.getItem(k)}catch(e){}if(p!=="light"&&p!=="dark")p="system";var t=p==="system"?(m&&m.matches?"dark":"light"):p;d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p)}a();window.__utsavTheme=a;if(m&&m.addEventListener)m.addEventListener("change",a);window.addEventListener("storage",function(e){if(e.key===k)a()})})();`;

export function readThemePref(): ThemePref {
  try { const v = window.localStorage.getItem(THEME_KEY); return isThemePref(v) ? v : "system"; } catch { return "system"; }
}
export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}
function apply(pref: ThemePref) {
  const dark = typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
  document.documentElement.setAttribute("data-theme", resolveTheme(pref, dark));
  document.documentElement.setAttribute("data-theme-pref", pref);
}

const listeners = new Set<() => void>();
export function setThemePref(pref: ThemePref) {
  try { window.localStorage.setItem(THEME_KEY, pref); } catch { /* storage disabled: still apply for this page */ }
  apply(pref);
  for (const l of listeners) l();
}
/** For useSyncExternalStore: this tab's toggles and other tabs' storage events. */
export function subscribeTheme(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}
