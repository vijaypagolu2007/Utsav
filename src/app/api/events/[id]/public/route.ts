// Public guest projection. Optional X-Guest-Token (the RSVP link's #fragment) opens the RSVP form; X-Device-Token (v8 Part 1c)
// adds this device's own RSVP, so the form opens prefilled. Never anybody else's.
import { getGuestView } from "@/server/events";
import { clientIp, fail, logServer, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try { return toResponse(await getGuestView(id, request.headers.get("x-guest-token"), clientIp(request), request.headers.get("x-device-token"))); }
  catch (e) { logServer("events", "internal_error", { op: "public", message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
