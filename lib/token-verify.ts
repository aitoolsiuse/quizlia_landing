// Credential-less Firebase ID-token verification.
//
// Verifies the JWT the same way firebase-admin does internally — signature
// against Google's rotating public keys (JWK form, verified with WebCrypto
// so this runs in ANY server runtime), plus issuer/audience/expiry checks
// against this project. No service account, no Node-only APIs.
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let jwkCache: { keys: Jwk[]; fetchedAt: number } | null = null;

function b64urlToBuffer(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwkCache && now - jwkCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return jwkCache.keys;
  }
  const response = await fetch(JWK_URL);
  if (!response.ok) throw new Error("Could not fetch Firebase public keys");
  const data = (await response.json()) as { keys: Jwk[] };
  jwkCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

export interface VerifiedToken {
  uid: string;
  email?: string;
}

async function verifyRs256(
  jwk: Jwk,
  signedContent: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as unknown as ArrayBuffer,
    signedContent as unknown as ArrayBuffer
  );
}

/** Verifies a Firebase ID token (RS256, Google public keys, project-bound).
 *  Returns the uid, or null when the token is invalid/expired/wrong project. */
export async function verifyIdToken(token: string): Promise<VerifiedToken | null> {
  try {
    if (!token || !PROJECT_ID) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBuffer(parts[0])));
    if (header.alg !== "RS256" || !header.kid) return null;

    const keys = await getJwks();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    // Signed content is the LITERAL ASCII text "header.payload" (the
    // base64url segments as text, dot included) — NOT their decoded bytes.
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = b64urlToBuffer(parts[2]);
    if (!(await verifyRs256(jwk, signed, signature))) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBuffer(parts[1])));

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
