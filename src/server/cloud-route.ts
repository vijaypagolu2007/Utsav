// Glue between the Next route files and the cloud handlers. Keyless: the only configuration is the public Firebase
// web config (NEXT_PUBLIC_FIREBASE_*); without it every cloud route answers 503. No service account, no server secret.
import { firebaseClientConfig } from "@/cloud-config";
import { fail, logServer, toResponse, type HandlerResult } from "./http";
import type { CloudDeps } from "./cloud-handler";
import { FirestoreRestRepo } from "./cloud-repo";
import { makeTokenVerifier } from "./firebase-token";
import { getStore } from "./store";

/** Firebase project ids: lowercase letters, digits and hyphens. Anything else is treated as "not configured". */
const PROJECT_ID = /^[a-z][a-z0-9-]{3,62}$/;

let cached: { projectId: string; deps: Omit<CloudDeps, "store"> } | null = null;

export function cloudDeps(config = firebaseClientConfig()): CloudDeps {
  const store = getStore().store;
  const projectId = config?.projectId;
  if (!projectId || !PROJECT_ID.test(projectId)) return { verifyToken: null, repo: null, store };
  if (cached?.projectId !== projectId) cached = { projectId, deps: { verifyToken: makeTokenVerifier(projectId), repo: new FirestoreRestRepo(projectId) } };
  return { ...cached.deps, store };
}

export async function runCloud(op: string, f: (deps: CloudDeps) => Promise<HandlerResult>): Promise<Response> {
  try { return toResponse(await f(cloudDeps())); }
  catch (e) {
    logServer("cloud", "internal_error", { op, name: e instanceof Error ? e.name : "error" });
    return toResponse(fail(500, "internal_error", "Something went wrong on the server"));
  }
}
