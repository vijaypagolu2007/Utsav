// Keyless Firebase ID-token verification (no service account, no firebase-admin). Server-only.
//
// A Firebase ID token is an RS256 JWT signed by Google's `securetoken` service. It is checked here exactly as Firebase
// documents: signature against Google's public JWKS, `aud` = project id, `iss` = https://securetoken.google.com/<id>,
// `exp` in the future, `iat` and `auth_time` in the past, and a non-empty `sub` of at most 128 characters (the uid).
// The project id is the public NEXT_PUBLIC_FIREBASE_PROJECT_ID, so the server holds no secret at all.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { VerifyToken } from "./cloud-handler";

export const SECURETOKEN_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/** Seconds of clock skew allowed between this server and Google. */
export const CLOCK_TOLERANCE_SEC = 30;

/** A rejected token. `code` is a short machine code that never quotes the token (safe to log). */
export class TokenRejected extends Error {
  constructor(readonly code: string) { super(`Firebase ID token rejected (${code})`); this.name = "TokenRejected"; }
}

let remoteJwks: JWTVerifyGetKey | null = null;
/** Google's signing keys, fetched lazily and cached by jose (refetched on an unknown `kid`, with a cooldown). */
const googleJwks = (): JWTVerifyGetKey => (remoteJwks ??= createRemoteJWKSet(new URL(SECURETOKEN_JWKS_URL), { timeoutDuration: 5000 }));

export type TokenVerifierOptions = {
  /** Key resolver; defaults to Google's remote JWKS. Tests pass a local JWKS signed with their own RSA key pair. */
  getKey?: JWTVerifyGetKey;
  now?: () => Date;
};

export function makeTokenVerifier(projectId: string, opts: TokenVerifierOptions = {}): VerifyToken {
  const issuer = `https://securetoken.google.com/${projectId}`;
  return async (idToken: string) => {
    const now = opts.now?.() ?? new Date();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, opts.getKey ?? googleJwks(), {
        algorithms: ["RS256"], issuer, audience: projectId, clockTolerance: CLOCK_TOLERANCE_SEC, currentDate: now,
        requiredClaims: ["exp", "iat", "sub", "auth_time"],
      }));
    } catch (e) {
      // jose's codes (ERR_JWT_EXPIRED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED, …) name the failure, never the token.
      const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code).slice(0, 60) : "verify_failed";
      throw new TokenRejected(code);
    }
    const nowSec = Math.floor(now.getTime() / 1000);
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) throw new TokenRejected("bad_sub");
    const authTime = payload.auth_time, iat = payload.iat;
    if (typeof authTime !== "number" || authTime > nowSec + CLOCK_TOLERANCE_SEC) throw new TokenRejected("bad_auth_time");
    if (typeof iat !== "number" || iat > nowSec + CLOCK_TOLERANCE_SEC) throw new TokenRejected("bad_iat");
    return { uid: sub };
  };
}
