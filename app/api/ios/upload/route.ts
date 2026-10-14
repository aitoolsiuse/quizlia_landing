import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export const dynamic = "force-dynamic";

// File-upload proxy for the iOS app (large PDFs etc. destined for the
// Gemini File API). Raw body is streamed through with the caller's
// Content-Type; the API key stays server-side. Same auth as the generate
// proxy. NOTE: platform function payloads cap around 6MB — phone-sized
// documents are fine; anything larger should be split before upload.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";

function adminInit() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) return false;
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
  }
  return true;
}

async function resolveUid(request: NextRequest): Promise<string | null> {
  const auth = getAuth();

  const bearer = request.headers.get("authorization") || "";
  const idToken = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  if (idToken) {
    try {
      return (await auth.verifyIdToken(idToken)).uid;
    } catch {
      return null;
    }
  }

  const refreshToken = request.headers.get("x-firebase-refresh");
  if (!refreshToken) return null;

  try {
    const webApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${webApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      }
    );
    const result = await response.json();
    if (!result.id_token) return null;
    return (await auth.verifyIdToken(result.id_token)).uid;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: { code: 500, message: "Gemini key not configured" } }, { status: 500 });
  }
  if (!adminInit()) {
    return NextResponse.json(
      { error: { code: 503, message: "Proxy not configured (FIREBASE_SERVICE_ACCOUNT missing)" } },
      { status: 503 }
    );
  }

  const uid = await resolveUid(request);
  if (!uid) {
    return NextResponse.json({ error: { code: 401, message: "Not authenticated" } }, { status: 401 });
  }

  try {
    const body = await request.arrayBuffer();

    const upstream = await fetch(`${UPLOAD_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") || "application/octet-stream",
        "X-Goog-Upload-Protocol": request.headers.get("x-goog-upload-protocol") || "raw",
      },
      body: Buffer.from(body),
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("iOS upload proxy error:", error);
    return NextResponse.json({ error: { code: 500, message: "Proxy failure" } }, { status: 500 });
  }
}
