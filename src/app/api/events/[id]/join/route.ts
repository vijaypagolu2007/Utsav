// v8 Part 1, public: the group join link. GET ?t=… checks the link (and returns the event's title and dates);
// POST { t, name, size, phone?, website? } files a pending join request for the organizer to approve.
// Rate limited per IP and event, with a honeypot field and a cap on pending requests (src/server/events.ts).
import { getJoinInfo, postJoinRequest } from "@/server/events";
import { clientIp, fail, logServer, readJsonLimited, toResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const internal = (op: string, e: unknown) => {
  logServer("events", "internal_error", { op, message: e instanceof Error ? e.message : String(e) });
  return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
};

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try { return toResponse(await getJoinInfo(id, new URL(request.url).searchParams.get("t"), clientIp(request))); } catch (e) { return internal("join_info", e); }
}

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await readJsonLimited(request, 4 * 1024);
  if (!body.ok) return toResponse(body.result);
  try { return toResponse(await postJoinRequest(id, body.value, clientIp(request))); } catch (e) { return internal("join", e); }
}
