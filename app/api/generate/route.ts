import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";

const PROMPTS = {
  note: `You are QuicNotes, an AI that extracts study notes from the given content.

TASK:
Analyze the provided content and return a structured summary in JSON format with the following keys:
- title: string (concise title of the content)
- key_findings: array of strings (as many key facts or statistics as possible)
- important_notes: array of strings (all relevant cautions, limitations, or extra details you can find)
- quick_summary: string (a detailed 15–25 sentence overall summary)

RULES:
- Capture all meaningful information, no artificial limits on list sizes.
- Keep language clear and concise.
- No extra commentary or formatting outside of JSON.
- If you cannot access or analyze the content, return: {"error": "content_not_accessible", "message": "Unable to access or analyze the provided content"}

RESPONSE FORMAT (JSON only):
{
  "title": "string",
  "key_findings": ["point 1", "point 2", "..."],
  "important_notes": ["point 1", "point 2", "..."],
  "quick_summary": "string"
}`,

  flashcard: `You are QuicNotes, an AI that generates study flashcards from the provided content.

TASK:
Generate the maximum number of high-quality flashcards possible from the content.
- No word count or time limit restrictions.
- Each flashcard should cover a unique and important concept.

Each flashcard must include:
- question: string (clear, concise; preferably under 20 words)
- answer: string (short, precise, factual)

RULES:
- No duplicate or trivial flashcards.
- Answers must be based only on the provided content.
- The assistant must return only valid JSON matching the schema below.
- If you cannot access or analyze the content, return: {"error": "content_not_accessible", "message": "Unable to access or analyze the provided content"}

RESPONSE FORMAT (JSON only):
{
  "flashcards": [
    { "question": "string", "answer": "string" }
  ]
}`,

  quiz: `You are QuicNotes, an AI that generates multiple-choice quiz questions from the given content.

TASK:
Generate the maximum possible number of high-quality MCQs from the content.
- Cover all important concepts with diverse, non-overlapping questions.

Each quiz must have:
- question: string (under 25 words)
- options: array of 4 distinct strings
- correct_answer: string (must exactly match one option)
- explanation: string (1–2 sentences)

RULES:
- Only one correct answer per question.
- Distractors must be plausible but clearly wrong.
- No duplicates.
- If you cannot access or analyze the content, return: {"error": "content_not_accessible", "message": "Unable to access or analyze the provided content"}

RESPONSE FORMAT (JSON only):
{
  "quizzes": [
    {
      "question": "string",
      "options": ["string","string","string","string"],
      "correct_answer": "string",
      "explanation": "string"
    }
  ]
}`,
};

function cleanJSONString(jsonString: string): string {
  let str = jsonString.trim();

  // Remove markdown fences
  if (str.startsWith("```json")) {
    str = str.substring(7);
  } else if (str.startsWith("```")) {
    str = str.substring(3);
  }

  if (str.endsWith("```")) {
    str = str.substring(0, str.length - 3);
  }

  return str.trim();
}

// Server-side quota enforcement. Active only when FIREBASE_SERVICE_ACCOUNT
// is configured (Netlify env); without it the route behaves as before
// (local/dev mode). One browser "generation" fires THREE requests here
// (note + flashcard + quiz), so limits are expressed in request units:
// free = 3 requests lifetime (= 1 generation), individual = 15/day
// (= 5 generations), family = 45/day (= 15 generations).
async function checkQuota(request: NextRequest): Promise<Response | null> {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) return null;

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return NextResponse.json({ error: "Sign in to generate content" }, { status: 401 });
  }

  try {
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
    }

    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getFirestore();

    // Plan from the subscription mirror (best server-side truth).
    const userSnap = await db.collection("users").doc(uid).get();
    const subs = (userSnap.data()?.subscriptions ?? {}) as Record<string, { active?: boolean }>;
    const hasActive = Object.values(subs).some((s) => s?.active);
    const isFamily = subs.family_yearly?.active === true;
    const dailyLimit = hasActive ? (isFamily ? 45 : 15) : 0;

    const today = new Date().toISOString().split("T")[0];
    const quotaRef = db.collection("generationQuota").doc(uid);
    const quotaSnap = await quotaRef.get();
    const data = quotaSnap.data() as { date?: string; used?: number; freeUsed?: boolean } | undefined;
    const usedToday = data?.date === today ? data?.used ?? 0 : 0;

    if (!hasActive) {
      // Free tier: one lifetime generation (= 3 request units).
      if (data?.freeUsed) {
        return NextResponse.json(
          { error: "Your free note has been used. Upgrade to keep generating.", upgrade: true },
          { status: 429 }
        );
      }
      await quotaRef.set({ date: today, used: usedToday + 1, freeUsed: true }, { merge: true });
    } else {
      if (usedToday >= dailyLimit) {
        return NextResponse.json(
          { error: `Daily generation limit reached (${isFamily ? 15 : 5} per day). Resets at midnight.`, upgrade: true },
          { status: 429 }
        );
      }
      await quotaRef.set({ date: today, used: usedToday + 1 }, { merge: true });
    }

    return null; // allowed
  } catch (error) {
    console.error("Quota check failed:", error);
    return NextResponse.json({ error: "Could not verify generation quota" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    // Server-side quota gate (no-op unless FIREBASE_SERVICE_ACCOUNT is set).
    const quotaError = await checkQuota(request);
    if (quotaError) return quotaError;

    const { type, content, fileData, mimeType } = await request.json();

    if (!GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "Gemini API key not configured" },
        { status: 500 }
      );
    }

    if (!type || !content) {
      return NextResponse.json(
        { error: "Missing type or content" },
        { status: 400 }
      );
    }

    const prompt = PROMPTS[type as keyof typeof PROMPTS];
    if (!prompt) {
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }

    // Prepare parts for Gemini API
    const parts: any[] = [];

    // Handle YouTube videos using File API (as per Google's video understanding docs)
    if (mimeType === "video/youtube" && content) {
      // For YouTube, we need to extract the video URL and use fileData
      const youtubeUrl = content.replace("Analyze the following link: ", "").trim();

      parts.push({
        fileData: {
          mimeType: "video/mp4", // YouTube videos are treated as video/mp4
          fileUri: youtubeUrl,
        },
      });

      // Add the prompt after the video
      parts.push({ text: prompt });
    } else {
      // For non-YouTube content, add prompt first
      const fullPrompt = `${prompt}\n\nCONTENT:\n${content}`;
      parts.push({ text: fullPrompt });

      // If file data is provided (image or PDF), add it as inline data
      if (fileData) {
        parts.push({
          inlineData: {
            mimeType: mimeType || "application/pdf",
            data: fileData,
          },
        });
      }
    }

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: parts,
          },
        ],
        generationConfig: {
          // Token allocation: 65536 for PDFs and YouTube videos, 16384 for URLs
          maxOutputTokens: (fileData || mimeType === "video/youtube") ? 65536 : 16384,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Gemini API error:", error);
      return NextResponse.json(
        { error: "Failed to generate content" },
        { status: 500 }
      );
    }

    const data = await response.json();
    const output =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!output) {
      return NextResponse.json(
        { error: "No output from Gemini" },
        { status: 500 }
      );
    }

    // Clean and parse JSON
    const cleanOutput = cleanJSONString(output);

    try {
      const parsed = JSON.parse(cleanOutput);

      // Check if AI returned an error response
      if (parsed.error) {
        const errorMessage = parsed.message || "Unable to generate content from the provided source";
        console.error("AI returned error:", parsed);
        return NextResponse.json(
          {
            success: false,
            error: parsed.error,
            message: errorMessage
          },
          { status: 400 }
        );
      }

      // Validate that we have actual content based on type
      if (type === "note" && (!parsed.title || !parsed.key_findings || !parsed.quick_summary)) {
        console.error("Invalid note structure:", parsed);
        return NextResponse.json(
          {
            success: false,
            error: "invalid_response",
            message: "AI did not return valid note content"
          },
          { status: 500 }
        );
      }

      if (type === "flashcard" && (!parsed.flashcards || !Array.isArray(parsed.flashcards) || parsed.flashcards.length === 0)) {
        console.error("Invalid flashcard structure:", parsed);
        return NextResponse.json(
          {
            success: false,
            error: "invalid_response",
            message: "AI did not return valid flashcard content"
          },
          { status: 500 }
        );
      }

      if (type === "quiz" && (!parsed.quizzes || !Array.isArray(parsed.quizzes) || parsed.quizzes.length === 0)) {
        console.error("Invalid quiz structure:", parsed);
        return NextResponse.json(
          {
            success: false,
            error: "invalid_response",
            message: "AI did not return valid quiz content"
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ success: true, data: parsed });
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      console.error("Raw output:", output);
      return NextResponse.json(
        {
          success: false,
          error: "parse_error",
          message: "Failed to parse AI response",
          raw: output
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "internal_error",
        message: "Internal server error"
      },
      { status: 500 }
    );
  }
}
