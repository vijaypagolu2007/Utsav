// v8 Part 1c, public: the open RSVP form. POST with X-Guest-Token (the RSVP link) and X-Device-Token (this browser's
// random id for the event) creates or updates this device's RSVP. Body capped at 4 KB and validated with Zod; rate limited
// per IP and per device; honeypot field "website" (src/server/events.ts).
import { postRsvp, RSVP_MAX_BODY_BYTES } from "@/server/events";
import { clientIp, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJsonLimited(request, RSVP_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await postRsvp(id, request.headers.get("x-guest-token"), request.headers.get("x-device-token"), body.value, clientIp(request))); }
  catch (e) { logServer("events", "internal_error", { op: "rsvp", message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
