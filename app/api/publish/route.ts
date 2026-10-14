import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const dynamic = "force-dynamic";

// Publish a user note as an UNLISTED public guide (shareable link, hidden
// from the browsable library until an admin sets listed: true). Writes go
// through the Admin SDK — clients still cannot write the notes collection
// directly (firestore.rules). Requires FIREBASE_SERVICE_ACCOUNT.
function adminDb() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) return null;
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
  }
  return getFirestore();
}

async function requireUid(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}

export async function POST(request: NextRequest) {
  const db = adminDb();
  if (!db) {
    return NextResponse.json({ error: "Publishing is not configured on this server." }, { status: 503 });
  }

  const uid = await requireUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Sign in to publish a note." }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { title, note, flashcards, quiz } = body;
    if (!title || !note) {
      return NextResponse.json({ error: "Nothing to publish." }, { status: 400 });
    }

    const slug = `${slugify(title)}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    // Stored in the same schema as seeded guides so the public page
    // renders it identically. listed:false keeps it out of the browse
    // section — only an admin can flip that.
    const guide = {
      slug,
      title,
      category: "community",
      difficulty: "medium",
      sourceChannel: "QuizliAI user",
      youtubeId: "",
      createdAt: now,
      updatedAt: now,
      tldr: Array.isArray(note.key_findings) && note.key_findings.length > 0
        ? note.key_findings.slice(0, 5)
        : [note.quick_summary].filter(Boolean),
      sections: [
        ...(note.quick_summary
          ? [{ title: "Summary", content: note.quick_summary, keyTerms: [] }]
          : []),
        ...(note.detailed_notes
          ? [
              {
                title: "Detailed Notes",
                content: note.detailed_notes,
                keyTerms: Array.isArray(note.key_findings) ? note.key_findings : [],
              },
            ]
          : []),
      ],
      quiz: Array.isArray(quiz) ? quiz : [],
      flashcards: Array.isArray(flashcards) ? flashcards : [],
      // Publishing metadata
      listed: false,
      ownerUid: uid,
      publishedAt: now,
    };

    await db.collection("notes").doc(slug).set(guide);

    return NextResponse.json({ slug, url: `/note/${slug}` });
  } catch (error: any) {
    console.error("Publish error:", error);
    return NextResponse.json({ error: "Failed to publish note." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const db = adminDb();
  if (!db) {
    return NextResponse.json({ error: "Publishing is not configured on this server." }, { status: 503 });
  }

  const uid = await requireUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Sign in to unpublish." }, { status: 401 });
  }

  try {
    const { slug } = await request.json();
    if (!slug) {
      return NextResponse.json({ error: "Missing slug." }, { status: 400 });
    }

    const ref = db.collection("notes").doc(slug);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Only the owner can unpublish their own note (admins via console).
    if (snap.data()?.ownerUid !== uid) {
      return NextResponse.json({ error: "You can only unpublish your own notes." }, { status: 403 });
    }

    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Unpublish error:", error);
    return NextResponse.json({ error: "Failed to unpublish." }, { status: 500 });
  }
}
