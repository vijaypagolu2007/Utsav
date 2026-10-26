// v8 Part 1c: the guest's device token. One random UUID per event, kept in this browser's localStorage and sent with every
// request on the RSVP link (X-Device-Token). The server stores only a salted hash of it and uses it as the upsert key, so
// opening the link again on the same device edits the same RSVP ("Welcome back"). The organizer's own device never
// writes it. Clearing site data, or a different browser, is a new device (a new RSVP; the phone dedupe flags it).
export const GUEST_DEVICE_KEY = "utsav_guest_device_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readAll(): Record<string, string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(GUEST_DEVICE_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, string> : {};
  } catch { return {}; }
}

/** A v4 UUID from the browser's CSPRNG (crypto.randomUUID where it exists, getRandomValues otherwise). */
export function newDeviceToken(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** This browser's token for one event, made on first use. Null only without window (server render). */
export function deviceTokenFor(eventId: string): string | null {
  if (typeof window === "undefined") return null;
  const all = readAll();
  const cur = all[eventId];
  if (typeof cur === "string" && UUID.test(cur)) return cur;
  const t = newDeviceToken();
  try { window.localStorage.setItem(GUEST_DEVICE_KEY, JSON.stringify({ ...all, [eventId]: t })); } catch { /* storage blocked: this visit still works */ }
  return t;
}
