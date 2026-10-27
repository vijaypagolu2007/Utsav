// v8 Part 2: ids for chat messages, toasts and toast actions. They used to come from a module-level counter, which
// restarts at 1 on every page load and is shared by every mounted planner; a random UUID never collides.
// crypto.randomUUID() only exists in secure contexts (https, localhost). The planner is also opened over plain http on a
// LAN address (a phone at http://192.168.1.20:3000), where it is missing, so fall back to a v4 UUID built from
// crypto.getRandomValues() (available everywhere), and only as a last resort to time + Math.random + a counter.
let fallbackSeq = 0;

export function newId(prefix = "m"): string {
  const c = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}-${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++fallbackSeq}`;
}
