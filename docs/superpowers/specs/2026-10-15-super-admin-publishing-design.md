# Super-admin publishing — design

Date: 2026-10-15
Repo: `quizlia_landing` (web only; iOS untouched — publishing was always web-only)

## Problem

Today any signed-in user can publish a note as an unlisted public guide. The
product direction is a curated public library: only a super admin publishes,
the admin's generations go **directly into the browsable library** (listed,
sitemapped, SEO-indexed), and the admin account has **no generation limits**.
Regular users get no publish ability at all.

## Design

### Admin flag

`users/{uid}.admin: true` — set or removed by Kevin directly in the Firebase
console (same `users` collection the subscription mirror lives in). No custom
claims, no scripts, no env vars.

### Firestore rules (the real enforcement)

- Creating or updating `notes` docs: allowed only when the writer's
  `users/{uid}.admin == true` (rules `get()` the user doc). Admin publishes may
  write `listed: true`.
- The `admin` field on `users/{uid}` is **never client-writable** — users keep
  their existing own-doc write paths (iOS subscription mirror), but any write
  that creates or changes `admin` is rejected. Nobody can self-promote.
- Deleting a `notes` doc stays allowed for its owner (`ownerUid`) — legacy
  unlisted links remain manageable by their publishers; only creation/update
  is admin-gated.
- Reads of `notes` and of one's own `users` doc stay public/allowed (guides
  must load for everyone; quota already REST-reads the user doc).

### Quota exemption (admin has no limit)

`lib/quota.ts`: `readPlan` becomes `readUser` returning `{ plan, admin }`
(same single REST read — zero extra requests). `meterGeneration` and
`meterChat` short-circuit to `{ ok: true }` when `admin` is true — no limit
check, no counter write. Applies to web `/api/generate` and the iOS proxy
alike (both meter through this module). Missing user doc or missing field →
not admin → today's behavior.

### Publish helper extraction

`handlePublish`'s core (slugify + `notes` doc build + `setDoc`) moves to
`lib/publishNote.ts` as `publishNoteToLibrary(topic, uid)` →
`{ slug, url }`. Takes an optional `listed` (default `true` — the admin
model always lists). The topic page's manual button and the generation
hook's auto-publish both call it; no duplicated publish logic.

### Web UI

- Admin state: `isAdmin(uid)` helper reading `users/{uid}.admin` via the web
  SDK (owner-read is already rule-allowed for quota). Topic page and
  generation hook each check once per session/sign-in.
- Topic page: Publish/Unpublish controls render only for admins.
- `useGenerateContent`: after a successful generation saves the new note
  item, if the current user is admin → `publishNoteToLibrary(...)` fires
  automatically (once, for the note; flashcards/quiz ride along in the same
  doc). Toast: "Published to library", link copied. Failure of the publish
  step never fails the generation itself — it surfaces as an error toast.

### Resulting flows

- Admin generates → note saved → auto-published listed → appears in the
  browsable library + sitemap (ISR, ≤1h) → link copied.
- Regular user generates → note saved, no publish anywhere, quotas as today.
- Pre-existing unlisted docs: links keep working; owners can still unpublish
  (delete); nobody but admin can create/update.

## Edge cases

- User doc missing / field absent → not admin (fail closed).
- Rules `get()` on user doc fails → deny write (fail closed).
- Re-generation creates a new slug; the old guide stays until unpublished
  (manual, admin-only UI for new docs; owner-delete preserved for legacy).
- Sitemap includes listed and unlisted (existing behavior) — admin notes are
  listed, so nothing new needed there.

## Verification

`npx tsc --noEmit` + eslint on changed files + `npm run build`; then Kevin
hand-verifies: flip `admin: true` in the Firebase console → publish controls
appear → a generation auto-publishes into the library; regular account → no
publish button, quota unchanged; rules deployed by Kevin (`firebase deploy
--only firestore:rules`) — a user-side step like `pod install`.

## Out of scope

- Admin management UI (console editing is the interface, by design).
- iOS UI changes (quota exemption reaches iOS through the shared server-side
  metering only).
- Migrating or pruning existing unlisted docs.
