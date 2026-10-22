// GET /api/event-templates → { templates: PublicTemplate[] }. Read-only; see src/server/templates-handler.ts.
import { handleEventTemplates } from "@/server/templates-handler";
import { fail, logServer, toResponse } from "@/server/http";

export const runtime = "nodejs";

export function GET() {
  try { return toResponse(handleEventTemplates()); }
  catch (e) { logServer("templates", "internal_error", { message: e instanceof Error ? e.message : String(e) }); return toResponse(fail(500, "internal_error", "Something went wrong on the server")); }
}
