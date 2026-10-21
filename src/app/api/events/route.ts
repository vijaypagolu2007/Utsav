// POST /api/events  { plan } → publish a shared copy; returns the organizer token once (store it client-side).
import { createSharedEvent, EVENTS_MAX_BODY_BYTES } from "@/server/events";
import { clientIp, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonLimited(request, EVENTS_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await createSharedEvent(body.value, clientIp(request))); }
  catch (e) { logServer("events", "internal_error", { op: "create", message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
