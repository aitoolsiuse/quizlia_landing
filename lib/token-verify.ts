// Credential-less Firebase ID-token verification.
//
// Verifies the JWT the same way firebase-admin does internally — signature
// against Google's rotating public certificates, plus issuer/audience/
// expiry checks against this project — without any service account. Used
// by the API routes (web generate + iOS proxy) so no server secret is
// required anywhere: the caller proves who they are, the rules prove what
// may be written.
import crypto from "crypto";

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certsCache: { keys: Record<string, string>; fetchedAt: number } | null = null;

function b64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function getCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certsCache && now - certsCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return certsCache.keys;
  }
  const response = await fetch(CERT_URL);
  if (!response.ok) throw new Error("Could not fetch Firebase public certs");
  const keys = (await response.json()) as Record<string, string>;
  certsCache = { keys, fetchedAt: now };
  return keys;
}

export interface VerifiedToken {
  uid: string;
  email?: string;
}

/** Verifies a Firebase ID token (RS256, Google public certs, project-bound).
 *  Returns the uid, or null when the token is invalid/expired/wrong project. */
export async function verifyIdToken(token: string): Promise<VerifiedToken | null> {
  try {
    if (!token || !PROJECT_ID) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8"));
    if (header.alg !== "RS256" || !header.kid) return null;

    const certs = await getCerts();
    const pem = certs[header.kid];
    if (!pem) return null;

    const signatureValid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      pem,
      b64urlToBuffer(parts[2])
    );
    if (!signatureValid) return null;

    const claims = JSON.parse(b64urlToBuffer(parts[1]).toString("utf8"));

    const nowSeconds = Math.floor(Date.now() / 1000);
    const issuerOk =
      claims.iss === `https://securetoken.google.com/${PROJECT_ID}` ||
      claims.iss === `https://securetoken.googleapis.com/projects/${PROJECT_ID}`;
    if (!issuerOk) return null;
    if (claims.aud !== PROJECT_ID) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;

    return { uid: claims.sub, email: claims.email };
  } catch {
    return null;
  }
}

/** Exchanges a Firebase refresh token for a fresh ID token using only the
 *  public web API key (no secret). Returns the ID token, or null. */
export async function exchangeRefreshToken(refreshToken: string): Promise<string | null> {
  try {
    const webApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!webApiKey || !refreshToken) return null;

    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${webApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      }
    );
    const result = await response.json();
    return result.id_token ?? null;
  } catch {
    return null;
  }
}

/** Resolves the caller from either an Authorization: Bearer ID token or
 *  the X-Firebase-Refresh header (exchanged server-side). */
export async function resolveCaller(
  authHeader: string,
  refreshHeader: string | null
): Promise<VerifiedToken | null> {
  if (authHeader.startsWith("Bearer ")) {
    const verified = await verifyIdToken(authHeader.slice(7));
    if (verified) return verified;
  }
  if (refreshHeader) {
    const idToken = await exchangeRefreshToken(refreshHeader);
    if (idToken) return verifyIdToken(idToken);
  }
  return null;
}
