# Shared-sync rollout runbook — release 1.0.12

Operational checklist for shipping the iOS↔web Firebase sync. Code is done on
both sides (web: merged to `main`, deploying via Netlify · iOS: branch
`release/1.0.12`). What remains are console/script/Mac steps only.

Order matters: Firebase prep → web migration → promo codes → iOS build & test → release.

## 0. Preconditions

- Firebase console access to **quailizy** (web project) and **quicknotes-15593** (legacy iOS project)
- A Mac with Xcode + `pod install` done for the QuickNote workspace
- Node on this Windows machine (for the migration script)
- A quailizy **service account key**: Firebase console → Project settings →
  Service accounts → Generate new private key

## 1. Firebase project prep (quailizy console)

1. **Authentication → Sign-in method**: enable **Anonymous** and **Email/Password**
   (both are used by the iOS sync settings).
2. **Firestore Database**: create in production mode if it doesn't exist.
3. **Deploy the security rules** from this repo (web):
   ```powershell
   # from quizlia_landing, with firebase CLI logged in
   firebase deploy --only firestore:rules
   ```
   `firestore.rules` already covers `users/{uid}/**` owner-only and `promoCodes` read-only.
4. Quick rules sanity check (console simulator): a request to `users/{otherUid}` with
   auth as yourself must be rejected.

## 2. Web user migration (email-keyed → uid-keyed) — SKIPPED

Decided 2026-10-14: there are no legacy users to migrate and the old
`quicknotes-15593` project is retired entirely (nothing references it).
The script below remains available if that ever changes:

```powershell
# Needs firebase-service-account.json (quailizy) in the repo root — see §2a
node scripts/migrate-to-uid.mjs            # dry-run: prints the copy plan + counts
node scripts/migrate-to-uid.mjs --apply    # write users/{emailDocId} -> users/{uid}
node scripts/migrate-to-uid.mjs --prune    # LATER, after burn-in: deletes source docs
```

## 2a. Service account key (needed for the admin scripts)

Firebase console → quailizy → Project settings → Service accounts →
Generate new private key → save the download as
`firebase-service-account.json` in the repo root (the filename is
git-ignored — verified). Revoke the key in the same tab when done.

## 3. Promo codes — created fresh in quailizy

```powershell
node scripts/create-promocodes.mjs LAUNCH100 FRIEND50            # explicit codes
node scripts/create-promocodes.mjs --count 20 --prefix QUIZ      # random batch (QUIZXXXXXX)
node scripts/create-promocodes.mjs LAUNCH100 --days 30 --dry-run # preview without writing
```

Docs land in `promoCodes/{CODE}` with the shape both platforms validate
(`expirationDate` Timestamp, `isActive: true`, `usersUsed: []` — the web
validates too since f703e59). Redeem a test code on each platform
afterwards (matrix below).

## 4. iOS build (Mac)

1. `git checkout release/1.0.12` in the QuickNote repo.
2. **Swap the config** (cannot be generated from code): Firebase console →
   quailizy → Your apps → iOS app `com.test.QuickNote` → download
   `GoogleService-Info.plist` → replace `QuickNote/GoogleService-Info.plist`.
   The committed plist still points at quicknotes-15593 — **do not ship with it**.
   (The file is gitignored per the SECRETS.md workflow; each machine keeps its own copy.)
3. `pod install` if Pods changed; build; the sync settings row ("Sync your data")
   is already wired in `SettingsViewController` — verify it presents link-email /
   status / delete-account.
4. Bump version/build for the 1.0.12 release as usual.

## 5. Test matrix (from the sync spec — Mac + browser)

- [ ] Two iOS devices, same linked account: note created offline on one appears
      on the other after launch
- [ ] Note created on web appears on iOS; note created on iOS appears on web
      (web side pulls iOS notes on every My Notes visit; web-created note
      content still merges on a device's first visit)
- [ ] Anonymous iOS user creates note → "Enable Sync" (link email) → data
      persists under the upgraded UID; sign in with the same email on web → sees it
- [ ] Promo code redemption works on both platforms (quailizy `promoCodes`)
- [ ] Firestore rules reject cross-UID reads (console simulator)
- [ ] "Delete Account" removes the `users/{uid}` subtree and signs out
      (web data for that account is gone too)
- [ ] Folder created on web appears on iOS (next launch) and vice versa
- [ ] Rename on either side propagates (web: next My Notes visit · iOS: next launch)
- [ ] Note created inside a folder lands in the same-named folder on the other platform
- [ ] Delete on iOS → folder gone on web, its web notes Unsorted
- [ ] Delete on web → folder gone on iOS, its iOS notes moved to General
- [ ] Existing user with pre-release folders opens My Notes signed in → the
      folderRegistry doc appears in the Firestore console (legacy folders upload)
- [ ] With a web-origin folder present: iOS registry writes settle within
      ≤2 passes per launch (watch the Firestore console; continuous writes
      indicate the rename-tracking or adopt loops regressed)
- [ ] Chat conversation held on browser A appears on browser B after
      visiting My Notes signed in
- [ ] An iOS note's AI seed answer appears as the web topic's opening chat
      message (when no local conversation exists)
- [ ] iOS note created after the web device has cached content appears on
      the web after visiting My Notes (per-visit pull cadence)

## 6. Release

- Web: already on `main`, Netlify auto-deploys.
- iOS: merge `release/1.0.12` per the usual ASC flow after the matrix passes.

## Known gaps — deliberately NOT in 1.0.12

- Folder organization syncs via the folderRegistry doc (spec:
  `docs/superpowers/specs/2026-10-12-folder-sync-design.md`). Notes pulled
  before this landed may still sit in web "Unsorted" / the iOS "From Web"
  folder — one-time residue, not auto-repaired.
- Chat history syncs web↔web (longer-history-wins, per-visit pull) and iOS
  AI seed answers import to web (spec: `docs/superpowers/specs/2026-10-13-sync-completion-design.md`).
  Web→iOS chat is not built — iOS has no persistent chat history to receive it.

- Note: `docs/quailizy-firebase-setup.md` (iOS repo, branch `release/1.0.12`)
predates the phase-2 commits — its "What is NOT in this phase" list is stale
(cross-platform pull shipped); this runbook supersedes it for rollout steps.
