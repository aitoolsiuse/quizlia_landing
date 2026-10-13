# Sync Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the remaining sync work: web↔web chat-history sync (longer-history-wins), iOS seed-answer import, per-visit pull cadence on My Notes, and the two iOS folder-sync polish fixes.

**Architecture:** Chat rides the existing `userContent` doc (web) and the existing `chat` field on iOS note docs — no new collections, docs, or rules. A shared `writeChatIfLonger` helper reconciles per-topic histories everywhere; the My Notes mount effect runs the idempotent iOS merge plus a new per-visit `pullRemoteChats` fetch.

**Tech Stack:** Web — Next.js client components, firebase JS SDK, TypeScript (verified: tsc/eslint/build). iOS — UIKit/FMDB/Firestore Swift on branch `release/1.0.12`, written on Windows to match idioms, compiled ONLY on the Mac.

**Spec:** `docs/superpowers/specs/2026-10-13-sync-completion-design.md`

## Global Constraints

- Web repo root: `e:\Projects\Arasheed\QuickNote\quizlia_landing`. Web work goes on branch `feature/sync-completion` (create in Task 2's commit step; nothing deploys until the user merges to main — Netlify auto-deploys main).
- iOS repo root: `e:\Projects\Arasheed\QuickNote\QuickNote`. iOS commits go on branch `release/1.0.12`. iOS code CANNOT be compiled on Windows — match existing idioms; Mac build is the gate.
- Chat merge semantics: **longer history wins**, per topic, everywhere. No union, no timestamps.
- Web local `content_<pid>` items NEVER gain a `chat` field in localStorage — chat attaches only to the cloud payload (and lives in its own `chat_<pid>_<topicId>` keys locally).
- Web chat message shape: `{ id: string; sender: "user" | "ai"; text: string }`. The iOS seed form is exactly `[{ id: "ios_seed", sender: "ai", text: <geminiChat string> }]`.
- Web verification: `npx tsc --noEmit`, `npx eslint <changed files>` (6 pre-existing errors live in untouched files; zero NEW problems is the bar), `npm run build`. No test framework exists; do not add one.
- Do NOT modify: `firestore.rules`, `lib/subscription.ts`, `lib/folderSync.ts`, the iOS ChatViewController.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: Web — chat plumbing in `lib/notesSync.ts`

**Files:**
- Modify: `lib/notesSync.ts`

**Interfaces:**
- Produces (Task 2 consumes): `applyRemoteChats(profileId: number | string, items: any[]): boolean` and `pullRemoteChats(profile: { id: number | string; email?: string }): Promise<boolean>` — both exported. `writeChatIfLonger` stays module-private. `mergeIOSNotesIntoContent` return value widens in meaning: true when items OR chat changed.

- [ ] **Step 1: Add the chat helpers (after `localContentKey`, before `persistProfileContent`)**

```ts
// Longer-history-wins chat reconciliation for one topic's messages
// (chats grow monotonically per topic; the longer array replaces the
// shorter). Web message shape: { id, sender: "user" | "ai", text }.
const writeChatIfLonger = (
  profileId: number | string,
  topicId: string,
  remote: Array<{ id: string; sender: string; text: string }> | null | undefined
): boolean => {
  if (typeof window === "undefined" || !Array.isArray(remote) || remote.length === 0) return false;
  const key = `chat_${profileId}_${topicId}`;
  let local: unknown[] = [];
  try {
    local = JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    local = [];
  }
  if (!Array.isArray(local) || remote.length > local.length) {
    localStorage.setItem(key, JSON.stringify(remote));
    return true;
  }
  return false;
};

// Applies chat histories carried on pulled content items (web↔web sync).
export function applyRemoteChats(
  profileId: number | string,
  items: any[]
): boolean {
  let changed = false;
  for (const item of items) {
    const sid = item?.sourceId;
    if (typeof sid !== "string" || !sid) continue;
    if (writeChatIfLonger(profileId, sid, item.chat)) changed = true;
  }
  return changed;
}
```

- [ ] **Step 2: Attach chats on push in `persistProfileContent`**

The function's try block currently builds the `setDoc` call with `content: JSON.stringify(content)`. Replace the whole try block with:

```ts
  try {
    const uid = auth.currentUser.uid;
    const ref = doc(db, "users", uid, "profiles", String(profile.id), "notes", "userContent");

    // Attach each topic's chat history to the CLOUD payload only (local
    // content_ items stay chat-free); receiving devices reconcile with
    // longer-history-wins via applyRemoteChats.
    const items = Array.isArray(content) ? (content as any[]) : [];
    const withChat = items.map((item) => {
      const sid = item?.sourceId;
      if (typeof sid !== "string" || !sid || typeof window === "undefined") return item;
      try {
        const chat = JSON.parse(localStorage.getItem(`chat_${profile.id}_${sid}`) || "[]");
        if (Array.isArray(chat) && chat.length > 0) return { ...item, chat };
      } catch {
        // no chat stored for this topic
      }
      return item;
    });

    await setDoc(ref, {
      clientOrigin: "web",
      updatedAt: new Date().toISOString(),
      content: JSON.stringify(withChat),
    });
  } catch (error) {
    console.warn("Cloud sync write failed (kept locally):", error);
  }
```

(Everything before the try block — the localStorage write and the Firebase guard — stays exactly as is.)

- [ ] **Step 3: Chat delivery on the first-visit path in `loadProfileContent`**

Inside `loadProfileContent`'s try block, after the `if (parsed && typeof window !== "undefined") { localStorage.setItem(...) }` block and before the `// Merge notes synced from the iOS app` comment, insert:

```ts
    if (Array.isArray(parsed)) {
      applyRemoteChats(profile.id, parsed);
    }
```

- [ ] **Step 4: iOS seed answers + known-topic chat in `mergeIOSNotesIntoContent`**

4a. The loop currently begins:

```ts
    for (const noteDoc of snap.docs) {
      if (!noteDoc.id.startsWith("ios_")) continue;
      if (known.has(noteDoc.id)) continue;

      const d = noteDoc.data() as Record<string, unknown>;
```

Replace those lines with:

```ts
    let chatChanged = false;
    for (const noteDoc of snap.docs) {
      if (!noteDoc.id.startsWith("ios_")) continue;

      const d = noteDoc.data() as Record<string, unknown>;

      // The iOS chat seed runs even for already-known topics: items are
      // idempotence-keyed by sourceId, but chat is length-compared.
      if (typeof d.chat === "string" && d.chat.trim().length > 0) {
        if (writeChatIfLonger(profile.id, noteDoc.id, [
          { id: "ios_seed", sender: "ai", text: d.chat },
        ])) {
          chatChanged = true;
        }
      }

      if (known.has(noteDoc.id)) continue;
```

4b. The function currently ends `return added;` (inside the try). Change that line to `return added || chatChanged;`. Also update the function's doc comment line "were merged (caller may reload)" to "or chat histories changed (caller may refresh)".

- [ ] **Step 5: Add `pullRemoteChats` (after `mergeIOSNotesIntoContent`, before `loadLegacyProfileContent`)**

```ts
// Per-visit web↔web chat delivery: fetches the consolidated userContent
// doc and reconciles chat histories. Content items themselves still merge
// only on the first-visit path — this is chat-only. Returns true when any
// chat history was updated.
export async function pullRemoteChats(
  profile: { id: number | string; email?: string }
): Promise<boolean> {
  if (!isFirebaseConfigured() || !db || !auth?.currentUser) return false;

  try {
    const uid = auth.currentUser.uid;
    const ref = doc(db, "users", uid, "profiles", String(profile.id), "notes", "userContent");
    const snap = await getDoc(ref);
    if (!snap.exists()) return false;
    const raw = snap.data().content;
    const items = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(items)) return false;
    return applyRemoteChats(profile.id, items);
  } catch (error) {
    console.warn("Chat pull failed:", error);
    return false;
  }
}
```

- [ ] **Step 6: Verify**

```
npx tsc --noEmit                          # exit 0
npx eslint lib/notesSync.ts               # zero problems
npm run build                             # exit 0
```

- [ ] **Step 7: Commit (creates the work branch)**

```bash
git checkout -b feature/sync-completion
git add lib/notesSync.ts
git commit -m "feat: chat sync plumbing - attach on push, longer-wins reconcile, per-visit pull

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

(Task 2 continues on this same branch.)

---

### Task 2: Web — per-visit pull cadence + runbook rows

**Files:**
- Modify: `app/note/notes/page.tsx`
- Modify: `docs/sync-rollout-runbook.md`

**Interfaces:**
- Consumes from Task 1: `pullRemoteChats(profile): Promise<boolean>`; `mergeIOSNotesIntoContent(profile): Promise<boolean>` (now true on items OR chat change); `syncProfileFolders` (existing).

- [ ] **Step 1: Extend the imports**

The notesSync import line currently reads:

```ts
import { persistProfileContent, loadProfileContent } from "@/lib/notesSync";
```

Change it to:

```ts
import { persistProfileContent, loadProfileContent, mergeIOSNotesIntoContent, pullRemoteChats } from "@/lib/notesSync";
```

- [ ] **Step 2: Replace the folder-sync mount effect with the combined per-visit sync**

The current effect (added by the folder-sync work) is:

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
  }, [profile]);
```

Replace the ENTIRE effect with (the `onRemoteDelete` body is unchanged; the effect now also runs the idempotent iOS-note merge and the chat pull every visit, refreshing topics in place when the merge added anything — no reload):

```ts
  // Per-visit cloud sync (signed-in only; each piece no-ops when signed out
  // or unchanged): folder registry (remote tombstones unsort via the hook),
  // the idempotent iOS-notes merge, and web↔web chat reconciliation.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;

    const stripFolderFromContent = (folderId: string) => {
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
    };

    (async () => {
      const [mergedFolders, notesAdded] = await Promise.all([
        syncProfileFolders(profile, { onRemoteDelete: stripFolderFromContent }),
        mergeIOSNotesIntoContent(profile),
        pullRemoteChats(profile),
      ]);
      if (cancelled) return;
      setFolders(mergedFolders as Folder[]);
      if (notesAdded && typeof window !== "undefined") {
        const stored = localStorage.getItem(`content_${profile.id}`);
        if (stored) {
          try {
            setTopics(buildTopics(JSON.parse(stored)));
          } catch {
            // leave the current list in place
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profile]);
```

- [ ] **Step 3: Add runbook matrix rows**

In `docs/sync-rollout-runbook.md` §5, append:

```markdown
- [ ] Chat conversation held on browser A appears on browser B after
      visiting My Notes signed in
- [ ] An iOS note's AI seed answer appears as the web topic's opening chat
      message (when no local conversation exists)
- [ ] iOS note created after the web device has cached content appears on
      the web after visiting My Notes (per-visit pull cadence)
```

And update the pull-cadence parenthetical — the matrix line currently reading:

```markdown
- [ ] Note created on web appears on iOS; note created on iOS appears on web
      (web side pulls iOS notes on a device's first visit / when local
      content is empty; broader pull cadence is a documented follow-up)
```

becomes:

```markdown
- [ ] Note created on web appears on iOS; note created on iOS appears on web
      (web side pulls iOS notes on every My Notes visit; web-created note
      content still merges on a device's first visit)
```

- [ ] **Step 4: Verify**

```
npx tsc --noEmit                            # exit 0
npx eslint app/note/notes/page.tsx          # zero NEW problems (2 known pre-existing warnings may remain)
npm run build                               # exit 0
```

- [ ] **Step 5: Commit (branch `feature/sync-completion` — continue from Task 1's branch)**

```bash
git add app/note/notes/page.tsx docs/sync-rollout-runbook.md
git commit -m "feat: per-visit pull cadence on My Notes; chat arrives cross-browser

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: iOS — folder-sync polish pair

**Files:**
- Modify: `QuickNote/Resource/QuizliSyncManager.swift` (iOS repo, branch `release/1.0.12`)

**Interfaces:**
- Consumes: nothing new — `localFolders`, `lastNames` map, and the adopt branch all exist in `syncAllFolders`'s main-queue block from the folder-sync work.
- Produces: nothing consumed by other tasks.

CANNOT be compiled on Windows — verification is exact transcription + structural self-review.

- [ ] **Step 1: Build the local-name index**

In `syncAllFolders`'s main-queue block, directly after the `let localFolders = DatabaseManager.shared … .filter { !self.isGeneralFolder($0.folderName) }` declaration, add:

```swift
                    let localNames = Dictionary(
                        uniqueKeysWithValues: localFolders.map { ($0.id, $0.folderName) })
```

- [ ] **Step 2: Make the adopt branch skip no-ops and store the capitalized name**

The adopt branch in section 3 currently reads:

```swift
                            } else if (entry["clientOrigin"] as? String) == "web",
                                      let name = entry["name"] as? String,
                                      !name.isEmpty {
                                // Web-origin rename of a known folder: adopt.
                                _ = DatabaseManager.shared.updateFolder(
                                    folderId: localId,
                                    newProfileId: profileId,
                                    newFolderName: name.firstLetterCapitalized)
                            }
```

Replace it with:

```swift
                            } else if (entry["clientOrigin"] as? String) == "web",
                                      let name = entry["name"] as? String,
                                      !name.isEmpty {
                                // Web-origin rename of a known folder: adopt,
                                // skipping the no-op write. lastNames stores the
                                // capitalized form to match the local row (kills
                                // the one-time case-flip push).
                                let target = name.firstLetterCapitalized
                                lastNames[fid] = target
                                if localNames[localId] != target {
                                    _ = DatabaseManager.shared.updateFolder(
                                        folderId: localId,
                                        newProfileId: profileId,
                                        newFolderName: target)
                                }
                            }
```

- [ ] **Step 3: Structural self-review**

1. `grep -n "localNames" QuickNote/Resource/QuizliSyncManager.swift` — exactly two hits (declaration + comparison).
2. `grep -n "lastNames\[fid\] = target" …` — one hit; the old `lastNames[fid] = name` adopt-branch line is gone (the rename/backfill/insert assignments elsewhere remain untouched).
3. Brace balance of the file unchanged (equal `{` and `}` counts).
4. `git status` — only `QuickNote/Resource/QuizliSyncManager.swift` modified.

- [ ] **Step 4: Commit (iOS repo, branch `release/1.0.12`)**

```bash
git checkout release/1.0.12   # if not already on it
git add QuickNote/Resource/QuizliSyncManager.swift
git commit -m "fix: adopt branch skips no-op writes and stores capitalized lastNames

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
