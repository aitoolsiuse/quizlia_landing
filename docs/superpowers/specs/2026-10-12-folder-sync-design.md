# Folder Sync — Design Spec

Date: 2026-10-12
Status: Approved
Parent: `docs/superpowers/specs/2026-10-08-shared-firebase-sync-design.md` (extends the shared sync schema)

## Problem

Notes sync between iOS and web, but folder organization does not:

- **iOS → Web:** iOS uploads every note doc with `folderName`, but the web merge
  (`mergeIOSNotesIntoContent`) ignores it — iOS notes land in web Unsorted.
- **Web → iOS:** the iOS pull (`pullWebContentOnce`) routes every web note into
  one hardcoded "From Web" folder — web folder structure collapses.

Root cause: folder definitions are device-local on both sides (web:
`localStorage folders_<pid>` with `Date.now()` string ids · iOS: SQLite
`UserFolder` rows with int ids). No shared registry, no shared identity.

Also conflicting delete semantics: iOS `deleteFolder` cascade-deletes the
folder's documents; web delete moves notes to Unsorted.

## Goals

1. Folder definitions sync both directions with **full CRUD** (create, rename,
   delete propagate), per the product owner's decision.
2. Notes land in the same folder on the other platform they were created in.
3. **Remote-applied deletes never destroy notes** (product owner decision):
   a tombstone arriving from the other platform removes the folder and moves
   its notes to Unsorted on the receiving side. Local deletes keep each
   platform's existing behavior.
4. No Firestore security-rules changes, no migration script.

## Cloud schema addition

`users/{uid}/profiles/{pid}/folders/folderRegistry` — one consolidated doc
(same pattern as the web's `notes/userContent`):

```json
{
  "folders": [
    {
      "id": "1760123456789",
      "name": "Biology",
      "icon": "📘",
      "clientOrigin": "web",
      "createdAt": "2026-10-12T…",
      "updatedAt": "<timestamp>",
      "deletedAt": null
    }
  ],
  "updatedAt": "<serverTimestamp>"
}
```

- **Identity:** web-origin folders use their existing local id as the cloud id
  (already a stable string). iOS-origin folders use `"ios_<sqliteId>"`. iOS
  keeps a local-int ↔ cloud-id map in UserDefaults (`folderDocIdMap`), the
  identical pattern to the existing `profileDocIdMap`.
- **LWW:** newest per-folder `updatedAt` wins. Writes are
  fetch-remote → merge → write, fire-and-forget (same posture as
  `persistProfileContent`). Race window (two devices writing within seconds)
  may lose one folder change — accepted at this scale.
- **Deletes are tombstones** (`deletedAt` set), so an offline device cannot
  resurrect a deleted folder on its next upsert.
- Icons: web sends its emoji string; iOS sends `null` (no icon concept) and
  the web renders its default folder icon for null.

## Note ↔ folder linkage

- Every synced note carries `fid` (cloud folder id) in addition to the existing
  `folderName` (kept as a legacy fallback):
  - iOS `upsertDocument` adds `"fid": <mapped id>` (omitted for the hidden
    General bucket).
  - Web content items' existing `folderId` **is** the fid (web local ids are
    the cloud ids).
- iOS's hidden `General` folder and the web's "no folder" both mean Unsorted
  and never sync as visible folders.
- Legacy notes without `fid` use name-based get-or-create on the receiving side.

## Delete semantics (decided)

| Where deleted | Acting side (local behavior) | Receiving side |
|---|---|---|
| iOS | Folder + its documents cascade-deleted locally (unchanged) | Tombstone → web removes folder, strips `folderId` from content items, `persistProfileContent` (notes become Unsorted) |
| Web | Notes move to Unsorted locally (unchanged) | Tombstone → iOS removes folder row, repoints its documents to the hidden General folder |

## Web implementation (built + verified on Windows)

| File | Change |
|---|---|
| `lib/folderSync.ts` (new) | `syncProfileFolders(profile): Promise<Folder[]>` — reads local `folders_<pid>`, fetches the registry, LWW-merges both directions in memory, writes back local + remote, returns the merged list. Registry types defined here. |
| `lib/notesSync.ts` | `mergeIOSNotesIntoContent` routes by `d.fid`: ensure a local folder with that id exists (created from `d.folderName` when absent), stamp `folderId: fid`. No `fid` → name-based get-or-create (legacy). |
| `app/note/notes/page.tsx` | On mount when signed in: `syncProfileFolders(profile).then(setFolders)` (single small doc fetch — also the delivery path for remote renames/deletes). Local create/rename/delete handlers fire the same sync non-blocking. Remote tombstone application shares the existing delete logic minus the confirm dialog (extracted helper). |

## iOS implementation (written on Windows to match idioms, Mac-verified)

- `QuizliSyncManager`:
  - `folderDocIdMap()` / `saveFolderDocIdMap(_:)` (UserDefaults).
  - `syncFolders(profileId:)` — bidirectional LWW merge: local folder missing
    but fid remembered → write tombstone; remote tombstone newer → delete local
    folder and repoint documents to General; remote rename newer → rename local;
    unknown remote folder → insert locally + record map entry. The hidden
    General folder is never upserted.
  - `upsertDocument` adds `"fid"`.
  - `pullWebContentOnce` routes items by `folderId` (fid) through the map,
    creating unknown folders from registry data; "From Web" remains only as the
    no-fid legacy fallback. Launch order becomes: profiles → folders → content
    pull → documents up.
  - Folder create/rename/delete UI flows call `syncFolders` when sync is enabled.
- `DatabaseManager`: bulk `updateDocumentsFolder(fromFolderId:toFolderId:)`
  (remote-delete unsort only; local delete behavior untouched).

## Migration / compatibility

- First web push uploads all existing web folders (ids become fids); iOS sees
  them at next launch. iOS folders push as `ios_<id>`.
- Notes already synced into the wrong place (web Unsorted / iOS "From Web")
  stay as-is — one-time residue, no auto-repair.
- The existing iOS "From Web" folder remains for legacy content.

## Error handling

- Web: all folder sync paths fire-and-forget with `console.warn` on failure;
  localStorage remains the source of truth locally. Merge is idempotent — next
  visit retries naturally.
- iOS: same non-blocking posture; folder sync failures surface nowhere in the
  UI and retry next launch. (The notes pendingSync queue is not extended to
  folders — the idempotent merge covers it.)

## Testing

- Web: `npx tsc --noEmit` + per-file eslint + `npm run build`; owner hand pass.
- Cross-device matrix additions (extend `docs/sync-rollout-runbook.md` §5):
  - Folder created on web appears on iOS (next launch) and vice versa.
  - Rename on either side propagates (web: next My Notes visit).
  - Note created inside a folder lands in the same-named folder on the other
    platform.
  - Delete on iOS → folder gone on web, its web notes Unsorted.
  - Delete on web → folder gone on iOS, its iOS notes in General.
- iOS compiles only on the Mac; Mac build is the verification gate for the
  iOS side.

## Out of scope

- Nested folders (iOS has none; web matches iOS by design).
- Folder reordering / drag positions.
- Auto-repair of pre-folder-sync misplaced notes.
