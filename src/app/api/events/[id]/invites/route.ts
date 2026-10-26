// v8 Part 1, organizer only: POST { householdId } gives that household a new private link (the old one answers 403).
import { resetHouseholdInvite } from "@/server/events";
import { bearerToken, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJsonLimited(request, 1024);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await resetHouseholdInvite(id, bearerToken(request), body.value)); }
  catch (e) { logServer("events", "internal_error", { op: "invite_reset", message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
