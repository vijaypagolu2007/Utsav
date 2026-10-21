// Guest self-service writes: RSVP, diet, wishlist claim (household invite required) and community sign-up.
import { postGuestActions } from "@/server/events";
import { clientIp, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJsonLimited(request, 16 * 1024);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await postGuestActions(id, request.headers.get("x-guest-token"), body.value, clientIp(request))); }
  catch (e) { logServer("events", "internal_error", { op: "guest", message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
