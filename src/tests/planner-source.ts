// v8 Part 2: PlannerApp's state moved into hooks under src/components/planner/. Static checks that used to read
// PlannerApp.tsx alone read it together with those hooks (PlannerApp first), so the same assertions still apply.
import { readdirSync, readFileSync } from "node:fs";

export function plannerSource(): string {
  const dir = new URL("../components/planner/", import.meta.url);
  const hooks = readdirSync(dir).filter(f => /\.tsx?$/.test(f)).sort().map(f => readFileSync(new URL(f, dir), "utf8"));
  return [readFileSync(new URL("../components/PlannerApp.tsx", import.meta.url), "utf8"), ...hooks].join("\n");
}
