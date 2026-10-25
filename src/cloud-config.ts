// Optional Google sign-in (Firebase Auth) configuration for the browser. These four values are a Firebase *web* app
// config: public identifiers, not secrets (access is enforced by the server's ID-token check and by firestore.rules,
// which let a signed-in user reach only users/{their uid}/plans/*). The server reads the project id too: it is the
// whole cloud-save configuration (keyless, no service account). They still come only from env, never a committed file.
// Each NEXT_PUBLIC_* is referenced literally so Next can inline it at build time.

export type FirebaseClientConfig = { apiKey: string; authDomain: string; projectId: string; appId: string };

export function firebaseClientConfig(env: Record<string, string | undefined> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}): FirebaseClientConfig | null {
  const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim();
  const authDomain = env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  const appId = env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim();
  return apiKey && authDomain && projectId && appId ? { apiKey, authDomain, projectId, appId } : null;
}
