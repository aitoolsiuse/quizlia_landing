# Super-Admin Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only a super admin can publish notes; the admin's generations auto-publish directly into the listed public library, and the admin account bypasses all generation/chat quotas.

**Architecture:** A `users/{uid}.admin` flag (set by Kevin in the Firebase console) is enforced in Firestore rules (admin-only `notes` writes, the `admin` field itself never client-writable, legacy owner-unpublish preserved), read by the web UI to gate publish controls, and read by the shared quota module (`lib/quota.ts`, REST with the caller's ID token — zero extra requests) to short-circuit metering. Publish logic is extracted to `lib/publishNote.ts` so the topic page button and the generation hook's auto-publish share one implementation.

**Tech Stack:** Next.js 16 + Firebase Web SDK + Firestore security rules (rules v2). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-super-admin-publishing-design.md`

## Global Constraints

- Web repo root: `e:\Projects\Arasheed\QuickNote\quizlia_landing`. No test framework exists and none may be added — verification = `npx tsc --noEmit` + `npx eslint <changed files>` (+ `npm run build` in the final task).
- Never count pre-existing eslint warnings (`react-hooks/set-state-in-effect` on topic/notes pages) as new failures.
- **Zero new dependencies.**
- A concurrent session commits to this repo — stage only your files by exact path, commit promptly, never push (the controller pushes).
- `firestore.rules` changes are NOT deployed by code — Kevin runs `firebase deploy --only firestore:rules` (user-side step, like `pod install`).
- The `admin` field must never be client-writable — that guarantee lives ONLY in the rules task; the UI task must not try to enforce it client-side.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: `lib/publishNote.ts` — publish helper + admin check

**Files:**
- Create: `lib/publishNote.ts`

**Interfaces:**
- Consumes: `db`, `auth` from `@/lib/firebase`; `Topic` from `@/lib/types`.
- Produces:
  - `isAdminUser(): Promise<boolean>` — reads `users/{uid}.admin`, fail-closed.
  - `publishNoteToLibrary(topic: Topic, uid: string): Promise<{ slug: string; url: string }>` — writes a `listed: true` guide doc.

- [ ] **Step 1: Create `lib/publishNote.ts`**

```ts
// Publishing notes as public library guides. Extracted from the topic
// page so manual publish (admin button) and auto-publish (admin
// generation) share one implementation. Firestore rules gate writes to
// admins; this code assumes the caller checked (or will find out on write).
import { doc, setDoc, getDoc } from "firebase/firestore";
import { db, auth } from "./firebase";
import type { Topic } from "./types";

/** Super admin check — users/{uid}.admin is set in the Firebase console. */
export async function isAdminUser(): Promise<boolean> {
  const user = auth?.currentUser;
  if (!user || !db) return false;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    return snap.exists() && snap.data()?.admin === true;
  } catch {
    return false;
  }
}

/** Publishes a topic as a LISTED public guide (library + sitemap). */
export async function publishNoteToLibrary(topic: Topic, uid: string): Promise<{ slug: string; url: string }> {
  if (!db) throw new Error("Firestore not initialized");
  const slugify = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  const slug = `${slugify(topic.title)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  // Same shape as seeded guides so the public page renders it identically.
  await setDoc(doc(db, "notes", slug), {
    slug,
    title: topic.title,
    category: "community",
    difficulty: "medium",
    sourceChannel: "QuizliAI user",
    youtubeId: "",
    createdAt: now,
    updatedAt: now,
    tldr:
      topic.note?.key_findings && topic.note.key_findings.length > 0
        ? topic.note.key_findings.slice(0, 5)
        : [topic.note?.quick_summary].filter(Boolean),
    // Real note fields so the public guide shows exactly what the topic
    // page shows (old docs without these keep the render fallbacks).
    quick_summary: topic.note?.quick_summary ?? "",
    key_findings: topic.note?.key_findings ?? [],
    important_notes: topic.note?.important_notes ?? [],
    sections: topic.note?.sections && topic.note.sections.length > 0
      ? topic.note.sections
      : [
          ...(topic.note?.quick_summary
            ? [{ title: "Summary", content: topic.note.quick_summary, keyTerms: [] }]
            : []),
          ...(topic.note?.detailed_notes
            ? [{
                title: "Detailed Notes",
                content: topic.note.detailed_notes,
                keyTerms: topic.note?.key_findings ?? [],
              }]
            : []),
        ],
    quiz: topic.quiz ?? [],
    flashcards: topic.flashcards ?? [],
    listed: true,
    ownerUid: uid,
    publishedAt: now,
  });

  return { slug, url: `${window.location.origin}/note/${slug}` };
}
```

- [ ] **Step 2: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint lib/publishNote.ts` → no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/publishNote.ts
git commit -m "feat: shared publish helper + super-admin check (lib/publishNote)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `lib/quota.ts` — admin bypasses all limits

**Files:**
- Modify: `lib/quota.ts` (readPlan → readUser; short-circuits in meterGeneration + meterChat)

**Interfaces:**
- Produces: unchanged public surface (`meterGeneration`, `meterChat`, `planFromSubscriptions`, `GENERATION_LIMITS`) — callers (`app/api/generate/route.ts`, `app/api/ios/gemini/[purpose]/route.ts`) need NO changes and both platforms get the bypass.
- Internal: `readUser(token, uid): Promise<{ plan: PlanKind; admin: boolean }>` replaces `readPlan`.

- [ ] **Step 1: Replace `readPlan` with `readUser`**

Change (current lines ~84-92):

```ts
async function readPlan(token: string, uid: string): Promise<PlanKind> {
  const user = await restGet(`users/${uid}`, token);
  const subs: any = user?.fields?.subscriptions?.mapValue?.fields ?? {};
  const parsed: Subs = {};
  for (const [key, value] of Object.entries(subs)) {
    parsed[key] = { active: (value as any)?.mapValue?.fields?.active?.booleanValue === true };
  }
  return planFromSubscriptions(parsed);
}
```

to:

```ts
async function readUser(token: string, uid: string): Promise<{ plan: PlanKind; admin: boolean }> {
  const user = await restGet(`users/${uid}`, token);
  const subs: any = user?.fields?.subscriptions?.mapValue?.fields ?? {};
  const parsed: Subs = {};
  for (const [key, value] of Object.entries(subs)) {
    parsed[key] = { active: (value as any)?.mapValue?.fields?.active?.booleanValue === true };
  }
  return {
    plan: planFromSubscriptions(parsed),
    admin: user?.fields?.admin?.booleanValue === true,
  };
}
```

- [ ] **Step 2: Short-circuit `meterGeneration`**

In `meterGeneration` (current lines ~104-110), change:

```ts
  const plan = await readPlan(token, uid);
  const quota = (await getQuota(token, uid)) ?? {};
  const isToday = quota.date === today();
```

to:

```ts
  const { plan, admin } = await readUser(token, uid);

  // Super admins generate without limits (and without metering).
  if (admin) return { ok: true };

  const quota = (await getQuota(token, uid)) ?? {};
  const isToday = quota.date === today();
```

- [ ] **Step 3: Short-circuit `meterChat`**

In `meterChat` (current lines ~146-149), change:

```ts
export async function meterChat(token: string, uid: string): Promise<QuotaResult> {
  const quota = (await getQuota(token, uid)) ?? {};
```

to:

```ts
export async function meterChat(token: string, uid: string): Promise<QuotaResult> {
  const { admin } = await readUser(token, uid);

  // Super admins chat without limits.
  if (admin) return { ok: true };

  const quota = (await getQuota(token, uid)) ?? {};
```

(Also update the header comment's budget note, adding one line after the budgets block: `//   super admin (users/{uid}.admin) → unlimited, unmetered`.)

- [ ] **Step 4: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint lib/quota.ts` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/quota.ts
git commit -m "feat: super admins bypass generation and chat quotas

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `firestore.rules` — enforcement

**Files:**
- Modify: `firestore.rules` (isAdmin function; `notes` match block; `users` match block header)

**Interfaces:**
- Produces: deployed by Kevin via `firebase deploy --only firestore:rules` (user-side step; the plan never deploys).

- [ ] **Step 1: Add the `isAdmin()` function**

Insert immediately after the `quizliaToday()` function's closing brace (before the `notes` match block):

```
    // Super admins: users/{uid}.admin == true, set directly in the
    // Firebase console (Admin SDK bypasses rules). A get() on a missing
    // doc fails closed — the write is denied.
    function isAdmin() {
      return request.auth != null
        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.get('admin', false) == true;
    }
```

- [ ] **Step 2: Replace the `notes` match block's write rules**

Change:

```
    match /notes/{noteId} {
      allow read: if true;
      allow create: if request.auth != null
                    && request.resource.data.ownerUid == request.auth.uid
                    && request.resource.data.listed == false;
      allow update: if request.auth != null
                    && resource.data.ownerUid == request.auth.uid
                    && resource.data.listed == false
                    && request.resource.data.listed == false;
      allow delete: if request.auth != null
                    && resource.data.ownerUid == request.auth.uid;
    }
```

to:

```
    match /notes/{noteId} {
      allow read: if true;
      // Publishing is super-admin-only now; admin publishes go straight
      // into the public library (listed). Legacy owners keep unpublish.
      allow create: if isAdmin()
                    && request.resource.data.ownerUid == request.auth.uid;
      allow update: if isAdmin()
                    && resource.data.ownerUid == request.auth.uid;
      allow delete: if request.auth != null
                    && resource.data.ownerUid == request.auth.uid;
    }
```

(Also update the comment above the block: replace "Signed-in users may publish their own notes as UNLISTED guides and unpublish them; featuring a guide (listed:true) and writing seeded guides stay admin-only (Admin SDK bypasses rules)." with "Only super admins (users/{uid}.admin) publish; their guides are listed library content. Owners keep unpublish (delete) on docs they created under the old model.")

- [ ] **Step 3: Guard the `admin` field on `users/{userId}`**

Change:

```
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
```

to:

```
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;

      // Owner-writable EXCEPT the admin flag: the post-write value of
      // `admin` (carried over when the write omits the field) must equal
      // the pre-write value, so nobody can self-promote. The console /
      // Admin SDK bypass rules to set it.
      allow create, update: if request.auth != null && request.auth.uid == userId
                    && request.resource.data.get('admin', resource.data.get('admin', false))
                       == resource.data.get('admin', false);

      allow delete: if request.auth != null && request.auth.uid == userId;
```

(The subcollection matches under this block — `profiles/{profileId}` etc. — stay exactly as they are.)

- [ ] **Step 4: Verify by reading**

No rules emulator here — re-read the full file checking: braces balanced; `isAdmin()` referenced only where `request.auth != null` is guaranteed or short-circuits first (it checks itself); the users create path sees `resource.data` as an empty map so `.get('admin', false)` is `false`; every prior rule behavior (quota block, promoCodes, subcollections) untouched.

- [ ] **Step 5: Commit**

```bash
git add firestore.rules
git commit -m "feat: notes writes are super-admin-only; admin flag never client-writable

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Topic page — admin-gated publish controls via the helper

**Files:**
- Modify: `app/note/topic/[id]/page.tsx` (imports ~10-15; admin state ~38; `handlePublish` 209-276; button block 524-550)

**Interfaces:**
- Consumes: `isAdminUser`, `publishNoteToLibrary` from `@/lib/publishNote` (Task 1).

- [ ] **Step 1: Update imports**

Change lines 11-12:

```ts
import { db, auth } from "@/lib/firebase";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
```

to:

```ts
import { db, auth } from "@/lib/firebase";
import { doc, deleteDoc } from "firebase/firestore";
import { isAdminUser, publishNoteToLibrary } from "@/lib/publishNote";
```

(`setDoc` becomes unused — handlePublish now delegates to the helper. `deleteDoc` stays for unpublish.)

- [ ] **Step 2: Add admin state** (after the `isPublishing` state, ~line 39)

```ts
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!auth?.currentUser) return;
    let cancelled = false;
    isAdminUser().then((v) => { if (!cancelled) setIsAdmin(v); });
    return () => { cancelled = true; };
  }, [auth?.currentUser?.uid]);
```

- [ ] **Step 3: Replace `handlePublish` body**

Change the whole function (lines 209-276) to:

```ts
  const handlePublish = async () => {
    if (!topic || isPublishing || !auth?.currentUser) {
      if (!auth?.currentUser) showToast("Sign in to publish a note", "error");
      return;
    }
    setIsPublishing(true);
    try {
      const { slug, url } = await publishNoteToLibrary(topic, auth.currentUser.uid);
      localStorage.setItem(publishedKey, slug);
      setPublishedSlug(slug);
      try {
        await navigator.clipboard.writeText(url);
        showToast("Published to library — link copied", "success");
      } catch {
        showToast("Published to library", "success");
      }
    } catch {
      showToast("Couldn't publish this note", "error");
    } finally {
      setIsPublishing(false);
    }
  };
```

- [ ] **Step 4: Gate the button block + update tooltip**

Change (lines 524-550):

```tsx
                {publishedSlug ? (
```

to:

```tsx
                {isAdmin && (publishedSlug ? (
```

and the block's closing `)}` (line 550) to `))}`. Then change the publish button's title:

```tsx
                    title="Make note public (unlisted link)"
```

to:

```tsx
                    title="Publish to the public library"
```

- [ ] **Step 5: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint "app/note/topic/[id]/page.tsx"` → 0 errors (pre-existing set-state warnings unchanged).

- [ ] **Step 6: Commit**

```bash
git add "app/note/topic/[id]/page.tsx"
git commit -m "feat: topic page publish controls are admin-only, listed via shared helper

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Generation hook — auto-publish for admins

**Files:**
- Modify: `hooks/useGenerateContent.ts` (imports 3-10; auto-publish block after line 223)

**Interfaces:**
- Consumes: `isAdminUser`, `publishNoteToLibrary` from `@/lib/publishNote`; `Topic` type from `@/lib/types` (already imports `Profile, ContentItem` from there).

- [ ] **Step 1: Update imports**

Change line 9:

```ts
import type { Profile, ContentItem } from "@/lib/types";
```

to:

```ts
import type { Profile, ContentItem, Topic } from "@/lib/types";
import { isAdminUser, publishNoteToLibrary } from "@/lib/publishNote";
```

- [ ] **Step 2: Add the auto-publish block**

After the `incrementUsage(profile.id);` line (223) and BEFORE the App Store QR comment block (225), insert:

```ts
      // Super admins: generation goes straight to the public library.
      // Failures never fail the generation itself.
      const noteItem = newItems.find((i) => i.type === "notes");
      if (noteItem && auth?.currentUser) {
        try {
          if (await isAdminUser()) {
            const flashcardItem = newItems.find((i) => i.type === "flashcards");
            const quizItem = newItems.find((i) => i.type === "quiz");
            const publishedTopic: Topic = {
              id: String(timestamp),
              title: noteItem.title,
              sourceType: contentType as Topic["sourceType"],
              createdAt: new Date().toISOString(),
              note: noteItem.data as Topic["note"],
              flashcards: flashcardItem?.data?.flashcards ?? [],
              quiz: quizItem?.data?.quizzes ?? [],
            };
            const { slug, url } = await publishNoteToLibrary(publishedTopic, auth.currentUser.uid);
            localStorage.setItem(`publishedSlug_${profile.id}_${timestamp}`, slug);
            try {
              await navigator.clipboard.writeText(url);
              showToast("Published to library — link copied", "success");
            } catch {
              showToast("Published to library", "success");
            }
          }
        } catch {
          showToast("Generated, but couldn't publish to the library", "error");
        }
      }
```

(The `publishedSlug_${profile.id}_${timestamp}` key matches the topic page's `publishedSlug_${profile.id}_${topicId}` — the topic page's topicId is this same item id — so the page shows the published state instead of a duplicate-publish button.)

- [ ] **Step 3: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint hooks/useGenerateContent.ts` → 0 errors (pre-existing warnings on this file, if any, unchanged).

- [ ] **Step 4: Commit**

```bash
git add hooks/useGenerateContent.ts
git commit -m "feat: admin generations auto-publish to the public library

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Full gates + Kevin's hand-off checklist

**Files:** none (verification + hand-off)

- [ ] **Step 1: Run the gates**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint lib/publishNote.ts lib/quota.ts "app/note/topic/[id]/page.tsx" hooks/useGenerateContent.ts` → 0 new errors/warnings.
Run: `npm run build` → succeeds.

- [ ] **Step 2: Hand Kevin the checklist** (rules deploy is HIS step — nothing works until rules are live):

1. `firebase deploy --only firestore:rules` (from the repo root).
2. Firebase console → your user doc → set `admin: true`.
3. Admin account: generate a note → toast "Published to library" → the guide appears at `/note/<slug>` AND in the browsable library; generate 20 notes → no quota toasts (unlimited).
4. Regular account: no publish button on the topic page; generation quota behaves as before.
5. Try setting `admin: true` from a signed-in regular client (console devtools Firestore write) → rules reject it.
6. Old unlisted link from a regular account → still loads; owner can still unpublish it.

- [ ] **Step 3: No commit.**

---

## Self-Review

- **Spec coverage:** flag (console, no code) ✓; rules enforcement incl. admin-field guard + legacy owner-delete ✓ Task 3; quota bypass both meters, zero extra reads ✓ Task 2; helper extraction ✓ Task 1; admin-gated UI ✓ Task 4; auto-publish listed + slug-key linkage + non-blocking failure ✓ Task 5; verification + rules-deploy hand-off ✓ Task 6. Out-of-scope items (admin UI, iOS changes, legacy migration) untouched.
- **Placeholders:** none — every step carries complete code/rules text.
- **Type consistency:** `publishNoteToLibrary(topic: Topic, uid: string) → { slug, url }` and `isAdminUser(): Promise<boolean>` used identically in Tasks 4/5; `readUser` replaces `readPlan` everywhere it was used (only `meterGeneration`); `Topic["note"]` cast matches `NoteData`.
