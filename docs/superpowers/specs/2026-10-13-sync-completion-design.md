# Sync Completion — Design Spec

Date: 2026-10-13
Status: Approved
Parent: `docs/superpowers/specs/2026-10-08-shared-firebase-sync-design.md` (Phase 3 + follow-ups)

## Problem

Three gaps remain after folder sync shipped:

1. **Pull cadence**: iOS-written notes (and any synced chat) only merge on a
   device's first visit (when `content_<pid>` is absent). A signed-in user
   with cached content never sees new iOS notes without clearing site data.
2. **Chat history never syncs**: web conversations live only in per-topic
   localStorage (`chat_<pid>_<topicId>`); iOS stores a single seed answer
   string per note (`geminiChat`) that already rides every synced note doc —
   but the web ignores it.
3. Two recorded iOS fast-follows: the adopt branch's lastNames case mismatch
   (one-time case-flip push) and its unconditional per-launch DB write
   (measured churn).

## Discovery that reframed the scope

iOS has **no persistent chat history**: `ChatViewController` seeds from the
stored single answer and never persists further turns (no UPDATE to
`geminiChat` anywhere). Therefore two-way conversation sync is impossible
without first building an iOS persistence feature — out of scope. Approved
scope: **web↔web conversation sync + iOS seed-answer import**; no web→iOS
chat.

## Decisions

- **Merge semantics for chat: longer history wins** (per topic). Chats grow
  monotonically per topic; the longer array replaces the shorter on the
  receiving side. Accepted edge: a message sent on the shorter side while
  offline can be dropped when a longer history lands.
- Chat rides the existing `userContent` doc and iOS note docs — **no new
  collections, no rules changes, no UI changes**.

## Design

### 1. Web↔Web chat sync

- **Push** (`persistProfileContent` in `lib/notesSync.ts`): before
  stringifying `content`, each item with a `sourceId` gets its topic's
  conversation attached as a `chat` array (parsed from
  `chat_<pid>_<sourceId>`) when that key exists and holds a non-empty array.
  Items without conversations push unchanged.
- **Pull** (`applyRemoteChats(profileId, items)` — new export in
  `lib/notesSync.ts`): for each pulled item carrying a `chat` array, compare
  lengths with the local `chat_<pid>_<sourceId>` history and write the longer
  one back to that key. Called from three receive paths: the first-visit
  `loadProfileContent` path, the per-visit iOS merge (seed answers, for docs
  whose `sourceId` is already known — the known-skip must not skip the chat
  step), and a per-visit `userContent` fetch (below).
- The web topic page already restores chat from that key — no UI change.

### 2. iOS seed-answer import

In `mergeIOSNotesIntoContent`: a non-empty `d.chat` string maps to
`[{ id: "ios_seed", sender: "ai", text: d.chat }]` and flows through the same
longer-history-wins write (`applyRemoteChats` handles the single-message
form; any existing local conversation is necessarily longer and wins).

### 3. Pull cadence

The My Notes mount effect (signed-in only) additionally runs, on every visit:
1. `mergeIOSNotesIntoContent(profile)` — already idempotent (known
   `sourceIds` skipped for items; the chat seed step runs even for known
   `sourceIds`), and
2. a new `pullRemoteChats(profile)` in `lib/notesSync.ts` — fetches the
   `userContent` doc, runs `applyRemoteChats` over its items (this is how
   web↔web chat arrives on repeat visits; note CONTENT itself still merges
   only on the first-visit path).
A `true` return from either refreshes the topics state from storage in place
(`setTopics(buildTopics(...))`, no reload). The first-visit reload-once path
is unchanged.

### 4. iOS polish pair (rides `release/1.0.12`, Mac-gated)

- Adopt branch writes `name.firstLetterCapitalized` into the lastNames map
  (matching the local row write), eliminating the one-time case-flip push.
- Adopt branch compares the registry name against the local folder's current
  name (dictionary from `localFolders`) and skips `updateFolder` when equal,
  eliminating the per-launch write + extra dirty pass.

## Error handling

All chat paths are fire-and-forget with `console.warn` (web) consistent with
the rest of notesSync; parse failures leave local chat untouched. iOS pair is
Mac-gated as usual.

## Testing

- Web: `npx tsc --noEmit`, per-file eslint, `npm run build`; owner hand pass.
- Runbook matrix rows (added to `docs/sync-rollout-runbook.md` §5):
  - Chat conversation held on browser A appears on browser B after visiting
    My Notes signed in.
  - An iOS note's AI seed answer appears as the web topic's opening chat
    message (when no local conversation exists).
  - New iOS note created after the web device has cached content appears on
    the web after visiting My Notes (pull-cadence fix).
- iOS: Mac build + the existing folder-sync rows.

## Out of scope

- Web→iOS chat (requires iOS persistent chat history first — separate feature).
- Orphaned chat keys on topic delete (pre-existing).
- The per-profile change counter for mid-pass folder marks (still deferred).
- Union-by-message-id merge (rejected in design).
