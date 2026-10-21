// Organizer-only: GET the full shared plan, PUT a new version (optimistic concurrency via baseVersion).
import { EVENTS_MAX_BODY_BYTES, getOrganizerEvent, putOrganizerEvent } from "@/server/events";
import { bearerToken, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const internal = (op: string, e: unknown) => {
  logServer("events", "internal_error", { op, message: e instanceof Error ? e.message : String(e) });
  return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
};

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try { return toResponse(await getOrganizerEvent(id, bearerToken(request))); } catch (e) { return internal("get", e); }
}

export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await readJsonLimited(request, EVENTS_MAX_BODY_BYTES);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await putOrganizerEvent(id, bearerToken(request), body.value)); } catch (e) { return internal("put", e); }
}
