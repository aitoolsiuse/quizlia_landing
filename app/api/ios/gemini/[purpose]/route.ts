import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const dynamic = "force-dynamic";

// Gemini proxy for the iOS app. The API key stays server-side; the app
// authenticates with its Firebase identity (ID token, or a refresh token
// which is exchanged server-side) and quotas are enforced per account:
//   /api/ios/gemini/generation — the notes pipeline: free = 1 lifetime,
//                              paid (subscription mirror) = 15/day
//   /api/ios/gemini/chat       — note chat + onboarding samples: 100/day
// The model is chosen here, so it can change without an app release.
// Requires FIREBASE_SERVICE_ACCOUNT (same env var as /api/generate).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";

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

  // The iOS client sends its (synchronously available) refresh token;
  // exchange it for an ID token and verify that.
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

async function checkQuota(purpose: string, uid: string): Promise<Response | null> {
  const db = getFirestore();
  const today = new Date().toISOString().split("T")[0];
  const quotaRef = db.collection("generationQuota").doc(uid);
  const quotaSnap = await quotaRef.get();
  const data = quotaSnap.data() as { date?: string; used?: number; chatUsed?: number; freeUsed?: boolean } | undefined;

  if (purpose === "generation") {
    // Plan from the subscription mirror (written by the app on purchase;
    // any active plan = family-equivalent daily budget on iOS).
    const userSnap = await db.collection("users").doc(uid).get();
    const subs = (userSnap.data()?.subscriptions ?? {}) as Record<string, { active?: boolean }>;
    const hasActive = Object.values(subs).some((s) => s?.active);

    if (!hasActive) {
      if (data?.freeUsed) {
        return NextResponse.json(
          { error: { code: 429, message: "Free note already used. Upgrade to keep generating." } },
          { status: 429 }
        );
      }
      await quotaRef.set({ date: today, used: (data?.date === today ? data.used ?? 0 : 0) + 1, freeUsed: true }, { merge: true });
      return null;
    }

    const used = data?.date === today ? data.used ?? 0 : 0;
    if (used >= 15) {
      return NextResponse.json(
        { error: { code: 429, message: "Daily generation limit reached (15 per day)." } },
        { status: 429 }
      );
    }
    await quotaRef.set({ date: today, used: used + 1 }, { merge: true });
    return null;
  }

  // chat / onboarding: a generous separate daily bucket so chat never
  // eats the generation budget.
  const used = data?.date === today ? data.chatUsed ?? 0 : 0;
  if (used >= 100) {
    return NextResponse.json(
      { error: { code: 429, message: "Daily limit reached. Try again tomorrow." } },
      { status: 429 }
    );
  }
  await quotaRef.set({ date: today, chatUsed: used + 1 }, { merge: true });
  return null;
}

export async function POST(request: NextRequest, context: { params: Promise<{ purpose: string }> }) {
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

  const { purpose } = await context.params;
  if (!["generation", "chat", "onboarding"].includes(purpose)) {
    return NextResponse.json({ error: { code: 404, message: "Unknown purpose" } }, { status: 404 });
  }

  const quotaError = await checkQuota(purpose, uid);
  if (quotaError) return quotaError;

  try {
    const body = await request.json();

    // Forward only what the Gemini REST API accepts; the model is fixed
    // server-side so it can change without an app release.
    const upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: body.contents,
        generationConfig: body.generationConfig,
      }),
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("iOS proxy error:", error);
    return NextResponse.json({ error: { code: 500, message: "Proxy failure" } }, { status: 500 });
  }
}
