// GET /api/cloud/plans: the signed-in organizer's cloud plans (summaries only). Logic in src/server/cloud-handler.ts.
import { handleCloudList } from "@/server/cloud-handler";
import { runCloud } from "@/server/cloud-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runCloud("list", deps => handleCloudList(request, deps));
}
