// GET one cloud plan, PUT a new version or a tombstone (compare-and-set on baseVersion), DELETE a tombstoned copy forever. Logic in src/server/cloud-handler.ts.
import { handleCloudDelete, handleCloudGet, handleCloudSave } from "@/server/cloud-handler";
import { runCloud } from "@/server/cloud-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ planKey: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { planKey } = await ctx.params;
  return runCloud("get", deps => handleCloudGet(request, planKey, deps));
}

export async function PUT(request: Request, ctx: Ctx) {
  const { planKey } = await ctx.params;
  return runCloud("save", deps => handleCloudSave(request, planKey, deps));
}

/** v8 Part 0c: "Delete forever" (owner-only, tombstoned copies only). */
export async function DELETE(request: Request, ctx: Ctx) {
  const { planKey } = await ctx.params;
  return runCloud("delete", deps => handleCloudDelete(request, planKey, deps));
}
