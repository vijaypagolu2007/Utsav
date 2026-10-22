// GET /api/event-templates: the public summary of every event template.
// Read-only and identical for every caller: no auth, no plan data, no guests, vendors or contact details.
// The registry is validated when the app loads (and so at build time); this handler validates again so a bad
// registry injected in tests, or one introduced later, becomes a clean 500 instead of a half-built response.
import { parseTemplateRegistry, TEMPLATE_DEFINITIONS, toPublicTemplate, type PublicTemplate } from "../config/event-templates";
import { fail, logServer, ok, type HandlerResult } from "./http";

export type TemplatesResponseBody = { templates: PublicTemplate[] };

let cached: HandlerResult | null = null;

export function handleEventTemplates(source: readonly unknown[] = TEMPLATE_DEFINITIONS): HandlerResult {
  const useCache = source === TEMPLATE_DEFINITIONS;
  if (useCache && cached) return cached;
  const reg = parseTemplateRegistry(source);
  if (!reg.ok) {
    // Details go to the server log only; the client gets a generic error with no paths or values.
    logServer("templates", "invalid_registry", { issues: reg.issues.slice(0, 5).join("; ") });
    return fail(500, "templates_unavailable", "Event templates are temporarily unavailable");
  }
  let body: TemplatesResponseBody;
  try { body = { templates: reg.templates.map(toPublicTemplate) }; }
  catch (e) {
    logServer("templates", "projection_failed", { message: e instanceof Error ? e.message : String(e) });
    return fail(500, "templates_unavailable", "Event templates are temporarily unavailable");
  }
  // Headers stay the API default (no-store): next.config.ts applies no-store to every /api route anyway, and the
  // payload is a few hundred bytes. The client never needs this request to start (the registry ships in the bundle).
  const result: HandlerResult = ok(body);
  if (useCache) cached = result;
  return result;
}
