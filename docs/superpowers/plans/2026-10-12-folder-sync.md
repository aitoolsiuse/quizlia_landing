# Folder Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folder definitions sync both directions between web and iOS with full CRUD (create/rename/delete via tombstones), and notes land in the same folder on the other platform.

**Architecture:** One consolidated registry doc per profile (`users/{uid}/profiles/{pid}/folders/folderRegistry`) mirrors the existing `notes/userContent` pattern. Web local folder ids ARE the cloud ids; iOS keeps a local↔cloud map in UserDefaults (same as its profile map) and syncs via dirty-profile tracking so web-side renames of iOS-origin folders aren't clobbered. Notes carry `fid` (cloud folder id) alongside the legacy `folderName`. Remote-applied deletes are tombstones that move notes to Unsorted, never destroying them.

**Tech Stack:** Web — Next.js client components, firebase JS SDK, TypeScript (verified: tsc/eslint/build). iOS — UIKit/FMDB/Firestore Swift, written on Windows to match existing idioms, compiled and verified ONLY on the Mac.

**Spec:** `docs/superpowers/specs/2026-10-12-folder-sync-design.md`

## Global Constraints

- Web repo root: `e:\Projects\Arasheed\QuickNote\quizlia_landing`. Web work goes on branch `feature/folder-sync` (Netlify auto-deploys `main` — nothing deploys until the user merges).
- iOS repo root: `e:\Projects\Arasheed\QuickNote\QuickNote`. iOS commits go on branch `release/1.0.12` (the repo's working tree may be on `release/1.0.11` — check out `release/1.0.12` first, and check it back is fine after). iOS code CANNOT be compiled on this Windows machine — match existing idioms exactly (force-unwrapped `UIColor(hex:)` convention, `DatabaseManager.shared` singletons, UserDefaults maps); the Mac build is the verification gate.
- The hidden iOS "General" folder (`"General\(Appconstants.isAppName)".lowercased()`, detected by `name.lowercased().hasPrefix("general")`) NEVER syncs as a visible folder; it maps to web "no folder" (Unsorted).
- Registry doc shape: `{ folders: [{ id: string, name: string, icon: string|null, clientOrigin: "web"|"ios", createdAt: string, updatedAt: Timestamp, deletedAt: Timestamp|null }], updatedAt: Timestamp }`. Web writes `icon` as its emoji string; iOS writes `NSNull()`. On the web, a remote `null` icon never clobbers an existing local icon.
- Web verification: `npx tsc --noEmit`, `npx eslint <changed files>` (6 pre-existing errors live in untouched files — zero NEW problems is the bar), `npm run build`. No test framework exists; do not add one.
- Do NOT modify: `firestore.rules` (already covers `users/{uid}/**`), `lib/subscription.ts`, the migration script.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: Web — folder registry sync (`lib/folderSync.ts`) + notes page integration

**Files:**
- Create: `lib/folderSync.ts`
- Modify: `app/note/notes/page.tsx`

**Interfaces:**
- Produces (Task 2 and iOS rely on this contract): `syncProfileFolders(profile, hooks?) => Promise<SyncedFolder[]>` where `SyncedFolder = { id: string; name: string; icon: string; createdAt: string; updatedAt: string; deletedAt?: string | null; clientOrigin?: "web" | "ios" }`. It reads/writes localStorage `folders_${profile.id}` itself (tombstones included in the stored array), merges with the registry doc LWW per folder by `updatedAt`, writes the merged registry back, and applies remote tombstones via the `hooks.onRemoteDelete(folderId)` callback (the caller strips notes). Web page `Folder` type gains `updatedAt?`, `deletedAt?`, `clientOrigin?`.

- [ ] **Step 1: Create `lib/folderSync.ts`**

```ts
// Folder-registry cloud sync (shared schema with the iOS app).
//
// Web keeps localStorage (`folders_${profileId}`) as the immediate cache and
// mirrors the profile's whole folder list to
// `users/{uid}/profiles/{pid}/folders/folderRegistry` — one consolidated doc
// (same pattern as notes/userContent). Last-write-wins per folder by
// updatedAt; deletes are tombstones (deletedAt) kept locally and remotely so
// an offline device cannot resurrect a deleted folder. Signed-out users get
// the local list untouched.
import { db, auth, isFirebaseConfigured } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

// Shape stored in localStorage folders_<pid> AND in the registry doc.
// Tombstoned entries (deletedAt set) stay in the array but are hidden by UI.
export interface SyncedFolder {
  id: string; // cloud id: web local id (stable string) or "ios_<sqliteId>"
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string; // ISO locally; Firestore Timestamp inside the registry
  deletedAt?: string | null;
  clientOrigin?: "web" | "ios";
}

export function localFoldersKey(profileId: number | string): string {
  return `folders_${profileId}`;
}

type RemoteFolder = {
  id: string;
  name: string;
  icon: string | null;
  clientOrigin: string;
  createdAt: string;
  updatedAt: { toDate(): Date } | string; // Firestore Timestamp or ISO
  deletedAt?: { toDate(): Date } | string | null;
};

const asDate = (v: unknown): number => {
  if (!v) return 0;
  if (typeof v === "string") return new Date(v).getTime() || 0;
  const maybe = v as { toDate?: () => Date };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  return 0;
};

export async function syncProfileFolders(
  profile: { id: number | string; email?: string },
  hooks?: { onRemoteDelete?: (folderId: string) => void }
): Promise<SyncedFolder[]> {
  const key = localFoldersKey(profile.id);
  let local: SyncedFolder[] = [];
  if (typeof window !== "undefined") {
    try {
      local = JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      local = [];
    }
  }

  if (!isFirebaseConfigured() || !db || !auth?.currentUser) return local;

  try {
    const uid = auth.currentUser.uid;
    const ref = doc(db, "users", uid, "profiles", String(profile.id), "folders", "folderRegistry");
    const snap = await getDoc(ref);
    const remote: RemoteFolder[] = snap.exists() ? (snap.data().folders as RemoteFolder[]) || [] : [];

    const byId = new Map<string, SyncedFolder>();
    for (const folder of local) byId.set(folder.id, folder);

    for (const r of remote) {
      const existing = byId.get(r.id);
      const remoteMs = asDate(r.updatedAt);
      const localMs = existing ? new Date(existing.updatedAt).getTime() || 0 : 0;

      if (!existing) {
        if (r.deletedAt) {
          // Tombstone for a folder this device has never seen: remember it
          // (kept locally and re-pushed) so a stale device cannot resurrect
          // the folder; nothing to unsort for an unknown folder.
          byId.set(r.id, {
            id: r.id,
            name: r.name || "deleted",
            icon: r.icon || "📁",
            createdAt: r.createdAt || new Date().toISOString(),
            updatedAt: new Date(remoteMs || Date.now()).toISOString(),
            deletedAt: new Date(asDate(r.deletedAt) || remoteMs || Date.now()).toISOString(),
            clientOrigin: (r.clientOrigin as "web" | "ios") || "ios",
          });
        } else {
          byId.set(r.id, {
            id: r.id,
            name: r.name,
            icon: r.icon || "📁",
            createdAt: r.createdAt || new Date().toISOString(),
            updatedAt: new Date(remoteMs || Date.now()).toISOString(),
            clientOrigin: (r.clientOrigin as "web" | "ios") || "ios",
          });
        }
        continue;
      }

      if (remoteMs > localMs) {
        if (r.deletedAt) {
          // Remote delete wins: unsort this folder's notes and KEEP the
          // tombstone locally (and in the push below) so every device
          // converges on the delete.
          hooks?.onRemoteDelete?.(r.id);
          byId.set(r.id, {
            ...existing,
            deletedAt: new Date(asDate(r.deletedAt)).toISOString(),
            updatedAt: new Date(remoteMs).toISOString(),
          });
        } else {
          // Remote edit/undelete wins: the folder is alive.
          byId.set(r.id, {
            ...existing,
            name: r.name,
            icon: r.icon || existing.icon, // remote null never clobbers a local emoji
            updatedAt: new Date(remoteMs).toISOString(),
            deletedAt: null,
          });
        }
      }
      // else: local is newer or equal — local entry (possibly a tombstone)
      // stays and is re-pushed below.
    }

    const merged = Array.from(byId.values());

    // Push the merged registry (creates, local edits, tombstones all ride along).
    await setDoc(ref, {
      clientOrigin: "web",
      updatedAt: new Date().toISOString(),
      folders: merged.map((f) => ({
        id: f.id,
        name: f.name,
        icon: f.icon || null,
        clientOrigin: f.clientOrigin || "web",
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        deletedAt: f.deletedAt || null,
      })),
    });

    if (typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(merged));
    }
    return merged;
  } catch (error) {
    console.warn("Folder sync failed (kept locally):", error);
    return local;
  }
}
```

- [ ] **Step 2: Integrate into `app/note/notes/page.tsx`**

Make these exact edits (the file is the current `main` version with the `renamedTitle` fix):

2a. Import it (next to the existing notesSync import):

```ts
import { persistProfileContent, loadProfileContent } from "@/lib/notesSync";
import { syncProfileFolders, localFoldersKey } from "@/lib/folderSync";
```

2b. Replace the local `Folder` interface:

```ts
interface Folder {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
  clientOrigin?: "web" | "ios";
}
```

2c. Add a visible-folders derivation right after the `folders` state declaration block (keep all existing state lines; add this line after `const [moveTopicTarget, setMoveTopicTarget] = useState<Topic | null>(null);`):

```ts
  // Tombstoned (remote-deleted) folders stay in state but are hidden by the UI.
  const visibleFolders = folders.filter((f) => !f.deletedAt);
```

2d. Add a mount-time folder sync effect directly after the study-guides `useEffect`:

```ts
  // Folder registry sync (signed-in only; no-ops to the local list otherwise).
  // Remote tombstones arrive here and unsort their notes via the hook.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    syncProfileFolders(profile, {
      onRemoteDelete: (folderId) => {
        if (!profile || typeof window === "undefined") return;
        const storedContent = localStorage.getItem(`content_${profile.id}`);
        if (storedContent) {
          const content = JSON.parse(storedContent).map((item: ContentItem) =>
            item.folderId === folderId ? { ...item, folderId: undefined } : item
          );
          persistProfileContent(profile, content);
        }
        setTopics((prev) =>
          prev.map((t) => (t.folderId === folderId ? { ...t, folderId: undefined } : t))
        );
      },
    }).then((merged) => {
      if (!cancelled) setFolders(merged as Folder[]);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);
```

2e. Update `persistFolders` to also kick a non-blocking registry push:

```ts
  const persistFolders = (next: Folder[]) => {
    setFolders(next);
    if (profile && typeof window !== "undefined") {
      localStorage.setItem(`folders_${profile.id}`, JSON.stringify(next));
      syncProfileFolders(profile).catch(() => {});
    }
  };
```

2f. `handleCreateFolder` stamps sync fields:

```ts
  const handleCreateFolder = (name: string, icon: string) => {
    persistFolders([
      ...folders,
      {
        id: String(Date.now()),
        name,
        icon,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientOrigin: "web",
      },
    ]);
    showToast(`Folder "${name}" created`, "success");
  };
```

2g. `handleRenameFolder` bumps `updatedAt`:

```ts
  const handleRenameFolder = (newName: string) => {
    if (!renameFolderTarget) return;
    persistFolders(
      folders.map((f) =>
        f.id === renameFolderTarget.id ? { ...f, name: newName, updatedAt: new Date().toISOString() } : f
      )
    );
    setRenameFolderTarget(null);
  };
```

2h. `handleDeleteFolder` tombstones instead of removing (existing body otherwise unchanged — keep the confirm, the `router.replace`, the content strip, and the `setTopics` map):

```ts
  const handleDeleteFolder = (folderId: string) => {
    if (!profile || typeof window === "undefined") return;
    if (!window.confirm("Delete this folder? Its topics move back to Unsorted.")) return;

    // Tombstone (kept in the array, hidden by the UI) so the delete syncs.
    persistFolders(
      folders.map((f) =>
        f.id === folderId ? { ...f, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : f
      )
    );
    if (folderParam === folderId) router.replace("/note/notes");

    const storedContent = localStorage.getItem(`content_${profile.id}`);
    if (storedContent) {
      const content = JSON.parse(storedContent).map((item: ContentItem) =>
        item.folderId === folderId ? { ...item, folderId: undefined } : item
      );
      persistProfileContent(profile, content);
    }
    setTopics((prev) => prev.map((t) => (t.folderId === folderId ? { ...t, folderId: undefined } : t)));
  };
```

2i. Every UI consumer of `folders` switches to `visibleFolders` EXCEPT the tombstone-preserving state code: the root tile grid (`folders.map((f) => (<FolderTile …` → `visibleFolders.map`), the root subtitle count (`folders.length` → `visibleFolders.length`), the "no folders" hint (`folders.length === 0` → `visibleFolders.length === 0`), the `MoveFolderModal` prop (`folders={folders.map((f) => ({ ...f, itemCount: countForFolder(f.id) }))}` → `visibleFolders.map((f) => ({ ...f, itemCount: countForFolder(f.id) }))`), and the `activeFolder` resolution (`folders.find((f) => f.id === folderParam)` → `visibleFolders.find((f) => f.id === folderParam)` — a tombstoned folder's URL renders the root view, same as an unknown id).

(Import only `syncProfileFolders` in 2a — `localFoldersKey` is not used by the page.)

- [ ] **Step 3: Verify**

```
npx tsc --noEmit            # exit 0
npx eslint lib/folderSync.ts app/note/notes/page.tsx   # zero NEW problems
npm run build               # exit 0
```

- [ ] **Step 4: Commit (branch `feature/folder-sync`)**

```bash
git checkout -b feature/folder-sync
git add lib/folderSync.ts app/note/notes/page.tsx
git commit -m "feat: folder registry sync (web side) with tombstoned deletes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Web — route pulled iOS notes by `fid`

**Files:**
- Modify: `lib/notesSync.ts` (the `mergeIOSNotesIntoContent` loop, currently lines ~98-166)

**Interfaces:**
- Consumes: iOS note docs will carry `fid` (string, cloud folder id) and `folderName` (string) — Task 3 adds `fid` on the iOS side; legacy docs have only `folderName` or neither.
- Consumes from Task 1: `localFoldersKey`, `SyncedFolder` from `@/lib/folderSync`.

- [ ] **Step 1: Add fid/name folder routing to the merge loop**

Inside `mergeIOSNotesIntoContent`, directly after the `const d = noteDoc.data() as Record<string, unknown>;` line, add:

```ts
    // Route the note into the same folder it lives in on iOS. fid is the
    // cloud folder id (registry); legacy docs fall back to folderName; the
    // hidden General bucket means Unsorted (no folderId).
    const resolveFolderId = (): string | undefined => {
      const fid = typeof d.fid === "string" && d.fid ? d.fid : null;
      const fname = typeof d.folderName === "string" ? d.folderName : "";

      const key = localFoldersKey(profile.id);
      let stored: SyncedFolder[] = [];
      try {
        stored = JSON.parse(localStorage.getItem(key) || "[]");
      } catch {
        stored = [];
      }

      const ensure = (id: string, name: string): string => {
        const hit = stored.find((f) => f.id === id && !f.deletedAt);
        if (hit) return id;
        stored.push({
          id,
          name: name || "Imported",
          icon: "📁",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          clientOrigin: "ios",
        });
        localStorage.setItem(key, JSON.stringify(stored));
        return id;
      };

      // fid is authoritative when present (a user folder legitimately named
      // "General Physics" keeps its notes); the hidden General bucket's
      // name rule applies only to legacy docs with no fid.
      if (fid) return ensure(fid, fname);
      if (fname.toLowerCase().startsWith("general")) return undefined;
      if (fname) {
        const byName = stored.find((f) => !f.deletedAt && f.name.toLowerCase() === fname.toLowerCase());
        if (byName) return byName.id;
        return ensure(`ios_name_${fname.toLowerCase().replace(/\s+/g, "_")}`, fname);
      }
      return undefined;
    };
    const folderId = resolveFolderId();
```

Then extend the `base` object with the folder:

```ts
      const base = {
        sourceId: noteDoc.id,
        sourceName: d.title,
        sourceType: mapType(d.contentType),
        title: d.title,
        createdAt: d.createdAt || new Date().toISOString(),
        folderId,
      };
```

And extend the import at the top of the file:

```ts
import { localFoldersKey, SyncedFolder } from "./folderSync";
```

- [ ] **Step 2: Verify**

```
npx tsc --noEmit
npx eslint lib/notesSync.ts     # zero NEW problems
npm run build                   # exit 0
```

- [ ] **Step 3: Commit**

```bash
git add lib/notesSync.ts
git commit -m "feat: pulled iOS notes keep their folder (fid routing, name fallback)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: iOS — QuizliSyncManager folder sync

**Files:**
- Modify: `QuickNote/Resource/QuizliSyncManager.swift` (iOS repo, branch `release/1.0.12`)

**Interfaces:**
- Consumes: registry doc contract from Task 1 (`folders` array on `folderRegistry`; entry `{id, name, icon, clientOrigin, createdAt, updatedAt, deletedAt}`), and web `userContent` items that carry `folderId` == cloud fid.
- Produces (Task 4 consumes): `func syncAllFolders()` (public — DatabaseManager hooks call it) and note docs gaining `"fid"`.

CANNOT be compiled on Windows. Verification = transcription review against this plan + a later Mac build. Every addition below follows the file's existing idioms (UserDefaults maps, `guard let uid`, Firestore completion style, FMDB work on the main queue).

- [ ] **Step 1: Check out the iOS branch**

```bash
cd /e/Projects/Arasheed/QuickNote/QuickNote
git checkout release/1.0.12
```

- [ ] **Step 2: Add the folder-sync section**

Insert this block immediately BEFORE the `// MARK: - Documents (up)` line:

```swift
    // MARK: - Folder sync (shared registry)
    //
    // Folder definitions live in one consolidated doc per profile
    // (folders/folderRegistry — same pattern as the web's notes/userContent).
    // Cloud ids: "ios_{sqliteId}" for this device's folders (unique DB-wide),
    // the web's own string ids for web-created ones; a UserDefaults map
    // keyed "profileId:localId" tracks local↔cloud identity so one profile's
    // dirty pass can never tombstone another profile's folders. Deletes are
    // tombstones so an offline device can't resurrect a folder; a tombstone
    // applied here repoints the folder's documents to the hidden General
    // folder instead of cascade-deleting them (remote deletes never destroy
    // notes). Pushes are dirty-driven: launches only backfill folders
    // missing from the registry, so a web-side rename of an ios-origin
    // folder is not clobbered by stale local names. Entry timestamps are
    // ISO strings — Firestore field transforms (serverTimestamp) cannot be
    // nested inside array elements; only the doc-level updatedAt uses one.

    private let folderMapKey = "syncFolderDocIdMap"
    private let folderDirtyKey = "syncFoldersDirtyProfiles"
    private let folderIso = ISO8601DateFormatter()

    /// Pending async registry passes. folderChangedLocally queues its dirty
    /// mark and re-checks after each completion instead of dropping it; the
    /// counter (not a Bool) survives overlapping per-profile completions.
    private var pendingFolderPasses = 0

    private func folderDocIdMap() -> [String: String] {
        if let data = UserDefaults.standard.data(forKey: folderMapKey),
           let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            return map
        }
        return [:]
    }

    private func saveFolderDocIdMap(_ map: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: map) {
            UserDefaults.standard.set(data, forKey: folderMapKey)
        }
    }

    private func remoteFolderId(forLocalId localId: Int, profileId: Int) -> String {
        return folderDocIdMap()["\(profileId):\(localId)"] ?? "ios_\(localId)"
    }

    private func localFolderId(forRemoteFolder fid: String) -> Int? {
        let map = folderDocIdMap()
        for (key, remoteId) in map where remoteId == fid {
            if let localId = key.split(separator: ":").last.flatMap({ Int(String($0)) }) {
                return localId
            }
        }
        if fid.hasPrefix("ios_"), let own = Int(fid.dropFirst(4)) {
            return own
        }
        return nil
    }

    private func isGeneralFolder(_ name: String) -> Bool {
        return name.lowercased().hasPrefix("general")
    }

    /// The hidden General bucket for this profile (created on demand) — the
    /// local equivalent of the web's "no folder".
    private func generalFolderId(profileId: Int) -> Int? {
        let name = "General\(Appconstants.isAppName)".lowercased()
        if let existing = DatabaseManager.shared.fetchFolderId(profileId: profileId, folderName: name) {
            return existing
        }
        _ = DatabaseManager.shared.insertFolder(
            profileId: profileId,
            folderName: name,
            createdAt: folderIso.string(from: Date()),
            folderImage: nil
        )
        return DatabaseManager.shared.fetchFolderId(profileId: profileId, folderName: name)
    }

    /// Called by DatabaseManager hooks after any local folder create/rename/
    /// delete (General excluded there). Queues the dirty mark FIRST — a
    /// change arriving mid-pass is picked up by the pass's completion
    /// re-check rather than lost — then kicks a pass if none is running.
    func folderChangedLocally(profileId: Int) {
        var dirty = UserDefaults.standard.array(forKey: folderDirtyKey) as? [Int] ?? []
        if !dirty.contains(profileId) {
            dirty.append(profileId)
            UserDefaults.standard.set(dirty, forKey: folderDirtyKey)
        }
        guard pendingFolderPasses == 0 else { return }
        syncAllFolders()
    }

    /// One pass over every profile: pull/merge the registry, backfill folders
    /// missing remotely, push dirty profiles' changes, apply remote
    /// tombstones (repoint documents to General, never delete them).
    func syncAllFolders() {
        guard let uid = uid else { return }
        let dirty = Set(UserDefaults.standard.array(forKey: folderDirtyKey) as? [Int] ?? [])

        for profile in DatabaseManager.shared.fetchProfiles() {
            guard let profileId = profile["id"] as? Int else { continue }
            pendingFolderPasses += 1
            let profileDoc = db.collection("users").document(uid)
                .collection("profiles").document(remoteDocId(forLocalId: profileId))
            let registry = profileDoc.collection("folders").document("folderRegistry")

            registry.getDocument { snapshot, _ in
                var remote: [[String: Any]] = []
                if let data = snapshot?.data(), let arr = data["folders"] as? [[String: Any]] {
                    remote = arr
                }

                DispatchQueue.main.async {
                    var map = self.folderDocIdMap()
                    var merged = remote
                    var changed = false
                    let now = self.folderIso.string(from: Date())

                    let localFolders = DatabaseManager.shared
                        .fetchFolders(forProfileId: profileId)
                        .filter { !self.isGeneralFolder($0.folderName) }

                    // 1) Backfill: local folders missing from the registry
                    //    (first sync, or a folder created while offline).
                    for folder in localFolders {
                        let fid = self.remoteFolderId(forLocalId: folder.id, profileId: profileId)
                        map["\(profileId):\(folder.id)"] = fid
                        if !merged.contains(where: { ($0["id"] as? String) == fid }) {
                            merged.append([
                                "id": fid,
                                "name": folder.folderName,
                                "icon": NSNull(),
                                "clientOrigin": "ios",
                                "createdAt": folder.createdAt,
                                "updatedAt": now,
                                "deletedAt": NSNull(),
                            ])
                            changed = true
                        }
                    }

                    // 2) Dirty pushes — scoped to THIS profile's map entries
                    //    ("pid:localId" keys) so another profile's folders
                    //    are never tombstoned here. Renames ride the same
                    //    pass as tombstones.
                    if dirty.contains(profileId) {
                        let localKeys = Set(localFolders.map { "\(profileId):\($0.id)" })
                        for (key, fid) in map
                        where key.hasPrefix("\(profileId):") && !localKeys.contains(key) {
                            // fids we remember but no longer have locally → tombstone
                            if let idx = merged.firstIndex(where: { ($0["id"] as? String) == fid }) {
                                var entry = merged[idx]
                                entry["deletedAt"] = now
                                entry["updatedAt"] = now
                                merged[idx] = entry
                            } else {
                                merged.append([
                                    "id": fid,
                                    "name": "deleted",
                                    "icon": NSNull(),
                                    "clientOrigin": "ios",
                                    "createdAt": "",
                                    "updatedAt": now,
                                    "deletedAt": now,
                                ])
                            }
                            changed = true
                        }
                        for folder in localFolders {
                            let fid = self.remoteFolderId(forLocalId: folder.id, profileId: profileId)
                            if let idx = merged.firstIndex(where: { ($0["id"] as? String) == fid }) {
                                merged[idx]["name"] = folder.folderName
                                merged[idx]["updatedAt"] = now
                                changed = true
                            }
                        }
                    }

                    // 3) Pull side: remote entries vs local knowledge.
                    for entry in merged {
                        guard let fid = entry["id"] as? String else { continue }
                        // Live entries carry deletedAt NSNull/null; tombstones
                        // carry a Timestamp (or ISO string from the web).
                        let tombstoned = !(entry["deletedAt"] is NSNull) && (entry["deletedAt"] != nil)

                        if let localId = self.localFolderId(forRemoteFolder: fid) {
                            if tombstoned {
                                // Remote delete: unsort, never destroy.
                                if let generalId = self.generalFolderId(profileId: profileId) {
                                    _ = DatabaseManager.shared.updateDocumentsFolder(
                                        fromFolderId: localId, toFolderId: generalId)
                                }
                                _ = DatabaseManager.shared.deleteFolder(folderId: localId, profileId: profileId)
                                map.removeValue(forKey: "\(profileId):\(localId)")
                                changed = true
                            } else if (entry["clientOrigin"] as? String) == "web",
                                      let name = entry["name"] as? String,
                                      !name.isEmpty {
                                // Web-origin rename of a known folder: adopt.
                                _ = DatabaseManager.shared.updateFolder(
                                    folderId: localId,
                                    newProfileId: profileId,
                                    newFolderName: name.firstLetterCapitalized)
                            }
                            continue
                        }

                        // Unknown fid: a folder created on the web.
                        guard !tombstoned,
                              let name = entry["name"] as? String,
                              !name.isEmpty else { continue }
                        _ = DatabaseManager.shared.insertFolder(
                            profileId: profileId,
                            folderName: name.firstLetterCapitalized,
                            createdAt: (entry["createdAt"] as? String) ?? now,
                            folderImage: nil)
                        if let newId = DatabaseManager.shared.fetchFolderId(
                            profileId: profileId, folderName: name.firstLetterCapitalized) {
                            map["\(profileId):\(newId)"] = fid
                        }
                        changed = true
                    }

                    self.saveFolderDocIdMap(map)

                    if changed || dirty.contains(profileId) {
                        registry.setData([
                            "clientOrigin": "ios",
                            "updatedAt": FieldValue.serverTimestamp(),
                            "folders": merged,
                        ], merge: true) { _, _ in }
                    }

                    // Clear only when this pass actually pushed the profile's
                    // changes (snapshot-dirty). A mark that arrived mid-pass —
                    // after the snapshot, before this clear — survives for the
                    // completion re-check to drain.
                    if dirty.contains(profileId) {
                        var remaining = UserDefaults.standard.array(forKey: self.folderDirtyKey) as? [Int] ?? []
                        remaining.removeAll { $0 == profileId }
                        UserDefaults.standard.set(remaining, forKey: self.folderDirtyKey)
                    }

                    self.pendingFolderPasses -= 1

                    // Changes that arrived mid-pass (hooks were guarded) or
                    // another still-dirty profile → one more pass.
                    if self.pendingFolderPasses == 0,
                       !(UserDefaults.standard.array(forKey: self.folderDirtyKey) as? [Int] ?? []).isEmpty {
                        self.syncAllFolders()
                    }
                }
            }
        }
    }
```

- [ ] **Step 3: Add `fid` to note upserts**

In `syncAllDocumentsUp()`, pass the fid through (replace the inner call):

```swift
                for folder in folders {
                    for document in DatabaseManager.shared.fetchDocuments(folderId: folder.id) {
                        let fid = isGeneralFolder(folder.folderName)
                            ? nil
                            : remoteFolderId(forLocalId: folder.id, profileId: profileId)
                        upsertDocument(document, profileId: profileId, folderName: folder.folderName, fid: fid, uid: uid)
                    }
                }
```

In `upsertDocument`, add the parameter and field (signature + one data entry):

```swift
    private func upsertDocument(_ document: DocumentModel, profileId: Int, folderName: String, fid: String?, uid: String) {
```

and inside the `data` dictionary, after `"folderName": folderName,`:

```swift
            "fid": fid ?? NSNull(),
```

- [ ] **Step 4: Route web-content pulls by fid**

In `groupWebItems`, capture the folder (inside the `if group.isEmpty {` block, after `group["contentType"] = …`):

```swift
                group["fid"] = item["folderId"] as? String
```

In `insertWebGroups`, replace the fixed "From Web" landing logic (the block from `// Get or create the landing folder…` through `guard let folderId = folderId else { return }`) with per-group routing — delete that block, and inside the `for (sid, group) in groups {` loop, before `let title = …`, resolve the folder:

```swift
            // Route by cloud folder id when we know it; only legacy items
            // (no fid) land in the catch-all "From Web" folder.
            let fid = group["fid"] as? String
            var targetFolderId: Int
            if let fid = fid, let localId = localFolderId(forRemoteFolder: fid) {
                targetFolderId = localId
            } else {
                var fallback = DatabaseManager.shared.fetchFolderId(profileId: profileId, folderName: "From Web")
                if fallback == nil {
                    _ = DatabaseManager.shared.insertFolder(
                        profileId: profileId,
                        folderName: "From Web",
                        createdAt: ISO8601DateFormatter().string(from: Date()),
                        folderImage: nil
                    )
                    fallback = DatabaseManager.shared.fetchFolderId(profileId: profileId, folderName: "From Web")
                }
                targetFolderId = fallback ?? 0
            }
            guard targetFolderId > 0 else { continue }
```

and change the `saveAIResponse(folderId: folderId, …)` call to use `folderId: targetFolderId`.

- [ ] **Step 5: Fix the launch order (folders before content pull)**

Replace `start()`:

```swift
    func start() {
        AnonymousAuthManager.shared.signInAnonymously { [weak self] success in
            guard let self = self, success else { return }
            self.syncProfilesUp()
            self.pullRemoteProfiles()
            self.syncAllDocumentsUp()
            // Folder registry first: the web-content pull routes by fid and
            // needs local folders + the identity map to exist.
            self.syncAllFolders()
            self.pullWebContentOnce()
        }
    }
```

(`pullWebContentOnce` itself keeps racing slightly with the registry's async write — acceptable: unknown fids fall back to "From Web" and route correctly on a later pull; pulled ids are recorded per sourceId so nothing duplicates.)

- [ ] **Step 6: Self-review against idioms, then commit**

Re-read the diff checking: force-unwrap conventions, `DatabaseManager.shared` style, main-queue DB access, no `pod install`/pbxproj edits needed (synchronized folder groups auto-include — but `QuizliSyncManager.swift` already exists in the project, so NO project file change is required for this task).

```bash
git add QuickNote/Resource/QuizliSyncManager.swift
git commit -m "feat: folder registry sync with tombstoned deletes and fid note routing

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: iOS — DatabaseManager bulk repoint + CRUD hooks

**Files:**
- Modify: `QuickNote/Database/DatabaseManger.swift` (iOS repo, branch `release/1.0.12`)

**Interfaces:**
- Consumes from Task 3: `QuizliSyncManager.shared.folderChangedLocally(profileId:)`, `isGeneralFolder` semantics (name check inlined here — DatabaseManager must not depend on SyncManager internals).
- Produces: `updateDocumentsFolder(fromFolderId: Int, toFolderId: Int) -> Bool` (used by Task 3's tombstone application).
- Threading contract: DatabaseManager's folder hooks call `QuizliSyncManager.shared.folderChangedLocally(profileId:)` on the main thread (FMDB work in this codebase is main-queue; the hook bodies are single no-wait calls).

- [ ] **Step 1: Add the bulk repoint function**

Insert directly AFTER the existing `deleteFolder(folderId:profileId:)` function:

```swift
    /// Bulk move for remote-applied folder deletes (sync only): documents in
    /// `fromFolderId` are repointed to `toFolderId` instead of being
    /// cascade-deleted — remote deletes never destroy notes.
    func updateDocumentsFolder(fromFolderId: Int, toFolderId: Int) -> Bool {
        database?.open()
        database?.executeUpdate("PRAGMA foreign_keys = ON", withArgumentsIn: [])

        let sql = "UPDATE Documents SET folderId = ? WHERE folderId = ?"
        let success = database?.executeUpdate(sql, withArgumentsIn: [toFolderId, fromFolderId]) ?? false

        database?.close()
        return success
    }
```

- [ ] **Step 2: Hook folder CRUD to the sync**

2a. In `insertFolder(…)`, the function currently ends:

```swift
        let success = database?.executeUpdate(sql, withArgumentsIn: [profileId, folderName, createdAt, imageData as Any]) ?? false

        database?.close()
        return success
```

Replace the ending with:

```swift
        let success = database?.executeUpdate(sql, withArgumentsIn: [profileId, folderName, createdAt, imageData as Any]) ?? false

        database?.close()

        // The hidden General bootstrap folder is never synced (it is the
        // Unsorted bucket); everything else kicks a registry pass.
        if success && !folderName.lowercased().hasPrefix("general") {
            QuizliSyncManager.shared.folderChangedLocally(profileId: profileId)
        }
        return success
```

2b. In `updateFolder(folderId:newProfileId:newFolderName:)`, which ends `database?.close()\n        return success`, insert the hook the same way:

```swift
        database?.close()

        if success {
            QuizliSyncManager.shared.folderChangedLocally(profileId: newProfileId)
        }
        return success
```

2c. In `deleteFolder(folderId:profileId:)`, same insertion before `return success`:

```swift
        if success {
            QuizliSyncManager.shared.folderChangedLocally(profileId: profileId)
        }
        return success
```

- [ ] **Step 3: Self-review, then commit**

Check the three hooks don't fire for the General bootstrap creates (the name guard covers 2a; delete/update of General is a no-op path in practice). No project-file edits (file already in the target).

```bash
git add QuickNote/Database/DatabaseManger.swift
git commit -m "feat: folder CRUD kicks registry sync; bulk repoint for remote deletes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Docs — runbook matrix rows + gap closure

**Files:**
- Modify: `docs/sync-rollout-runbook.md` (web repo, branch `feature/folder-sync`)

- [ ] **Step 1: Extend the test matrix**

In §5, append:

```markdown
- [ ] Folder created on web appears on iOS (next launch) and vice versa
- [ ] Rename on either side propagates (web: next My Notes visit · iOS: next launch)
- [ ] Note created inside a folder lands in the same-named folder on the other platform
- [ ] Delete on iOS → folder gone on web, its web notes Unsorted
- [ ] Delete on web → folder gone on iOS, its iOS notes moved to General
```

- [ ] **Step 2: Update the known-gaps section**

Replace the first gap bullet ("**Folder organization does not sync** …") with:

```markdown
- Folder organization syncs via the folderRegistry doc (spec:
  `docs/superpowers/specs/2026-10-12-folder-sync-design.md`). Notes pulled
  before this landed may still sit in web "Unsorted" / the iOS "From Web"
  folder — one-time residue, not auto-repaired.
```

- [ ] **Step 3: Commit**

```bash
git add docs/sync-rollout-runbook.md
git commit -m "docs: folder-sync matrix rows and gap closure in rollout runbook

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Post-review fixes (2026-10-13, final whole-branch review)

Applied after the cross-repo final review (fix commits on this branch and release/1.0.12):
- Web: legacy folders normalized with `updatedAt` on load (Firestore rejects `undefined`); `ensure()` routes notes of tombstoned folders to Unsorted (no resurrection); runbook matrix + pull-cadence corrections.
- iOS: note docs written under the profile doc id (`remoteDocId`) so the web's read path matches; last-synced-name map so dirty pushes only carry genuine local renames; dirty mark cleared only on successful registry write; backfill adopts a same-named live registry entry's fid (two-device dedupe); `updateDocumentsFolder` profile-scoped; profile deletion removes the registry doc; "From Web" excluded from the insert hook; account wipe clears folder-sync UserDefaults.

Accepted fast-follows (not fixed): iOS adopt-branch no-op DB write churn per launch (bounded); web pull cadence still first-visit-per-device (pre-existing); deep-offline `getDocument` stall holds the pass counter until next launch.
