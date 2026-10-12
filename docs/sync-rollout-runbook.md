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

## 2. Web user migration (email-keyed → uid-keyed)

From `quizlia_landing` on this machine. Dry-run is the default; nothing writes
until `--apply`; sources are only deleted by a later `--prune`.

```powershell
# Option A: service account inline
$env:FIREBASE_SERVICE_ACCOUNT = '{"project_id":"quailizy", ...full key json...}'
# Option B: save the key as firebase-service-account.json in the repo root (gitignored? verify — do NOT commit it)

node scripts/migrate-to-uid.mjs            # 1. dry-run: prints the copy plan + counts
node scripts/migrate-to-uid.mjs --apply    # 2. write users/{emailDocId} -> users/{uid} (+ profiles subtree)
# 3. verify in console: users/{uid} docs exist for a couple of known emails,
#    and the web app still shows those users' notes
node scripts/migrate-to-uid.mjs --prune    # 4. LATER, after burn-in: deletes migrated source docs
```

Re-runnable and idempotent — safe to run `--apply` twice. **Never commit the
service-account key.**

## 3. Promo codes: quicknotes-15593 → quailizy

1. Legacy console (quicknotes-15593) → Firestore → `promoCodes` → ⋮ → Export JSON.
2. quailizy console → Firestore → import (or paste documents) into the same
   collection name `promoCodes`. Same shape (`isActive`, `expirationDate`,
   `usersUsed`) — no code changes needed.
3. Redeem one test code in each app afterwards (matrix below).
4. quicknotes-15593 stays read-only; retire after burn-in.

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
      (web side needs one reload / folder visit to pull)
- [ ] Anonymous iOS user creates note → "Enable Sync" (link email) → data
      persists under the upgraded UID; sign in with the same email on web → sees it
- [ ] Promo code redemption works on both platforms (quailizy `promoCodes`)
- [ ] Firestore rules reject cross-UID reads (console simulator)
- [ ] "Delete Account" removes the `users/{uid}` subtree and signs out
      (web data for that account is gone too)

## 6. Release

- Web: already on `main`, Netlify auto-deploys.
- iOS: merge `release/1.0.12` per the usual ASC flow after the matrix passes.

## Known gaps — deliberately NOT in 1.0.12

- **Folder organization does not sync**: iOS notes land in web "Unsorted" (the
  web merge ignores `folderName`); web notes land in one iOS "From Web" folder.
  Folder definitions are device-local on both sides. Next design round.
- **Chat history sync** — optional Phase 3 per the spec, not built.

Note: `docs/quailizy-firebase-setup.md` (iOS repo, branch `release/1.0.12`)
predates the phase-2 commits — its "What is NOT in this phase" list is stale
(cross-platform pull shipped); this runbook supersedes it for rollout steps.
