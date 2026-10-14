// Create promo codes in the quailizy `promoCodes` collection (the shape the
// iOS app validates: { expirationDate: Timestamp, isActive: true, usersUsed: [] }).
//
// Usage (service account via FIREBASE_SERVICE_ACCOUNT env var or
// firebase-service-account.json in the repo root — same file the migration
// script uses; the filename is git-ignored):
//   node scripts/create-promocodes.mjs LAUNCH100 FRIEND50          # explicit codes
//   node scripts/create-promocodes.mjs --count 20 --prefix QUIZ    # random batch
//   node scripts/create-promocodes.mjs LAUNCH100 --days 30         # redeemable 30 days
//   node scripts/create-promocodes.mjs LAUNCH100 --dry-run         # print only, no write
//   node scripts/create-promocodes.mjs LAUNCH100 --force           # overwrite existing
import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const COUNT = flagValue("--count", null);
const PREFIX = (flagValue("--prefix", "QUIZ")).toUpperCase();
const DAYS = parseInt(flagValue("--days", "365"), 10);

const explicit = args.filter((a) => !a.startsWith("--") && a !== COUNT && a !== PREFIX && a !== String(DAYS));
if (explicit.length > 0 && COUNT) {
  console.error("Pass either explicit codes or --count, not both.");
  process.exit(1);
}
if (explicit.length === 0 && !COUNT) {
  console.error("Nothing to create: pass explicit codes and/or --count N.");
  console.error("Usage: node scripts/create-promocodes.mjs CODE1 [CODE2 ...] [--count N] [--prefix QUIZ] [--days 365] [--dry-run] [--force]");
  process.exit(1);
}
if (isNaN(DAYS) || DAYS <= 0) {
  console.error("--days must be a positive number.");
  process.exit(1);
}

// Random codes use an unambiguous alphabet (no 0/O/1/I).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () =>
  Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

const codes = [
  ...explicit.map((c) => c.toUpperCase()),
  ...Array.from({ length: COUNT ? parseInt(COUNT, 10) : 0 }, randomCode),
].map((c) => (PREFIX && COUNT ? `${PREFIX}${c}` : c)); // random batch gets the prefix; explicit codes stay verbatim

const expires = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000);
const expiresHuman = expires.toISOString().slice(0, 10);

const table = codes.map((code) => ({ code, expires: expiresHuman }));
console.log(`${DRY_RUN ? "[dry-run] would create" : "creating"} ${codes.length} code(s), redeemable until ${expiresHuman}:\n`);
for (const { code, expires: e } of table) console.log(`  ${code.padEnd(16)} expires ${e}`);

if (DRY_RUN) {
  console.log("\n[dry-run] nothing written.");
  process.exit(0);
}

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : (() => {
      try {
        return JSON.parse(readFileSync("firebase-service-account.json", "utf8"));
      } catch {
        console.error("Provide FIREBASE_SERVICE_ACCOUNT env var or firebase-service-account.json (quailizy service account).");
        process.exit(1);
      }
    })();

const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

let created = 0;
let skipped = 0;
for (const code of codes) {
  const ref = db.collection("promoCodes").doc(code);
  const existing = await ref.get();
  if (existing.exists && !FORCE) {
    console.log(`  skipped ${code} (already exists; use --force to overwrite)`);
    skipped++;
    continue;
  }
  await ref.set({
    expirationDate: Timestamp.fromDate(expires),
    isActive: true,
    usersUsed: [],
  });
  console.log(`  ${existing.exists ? "overwrote" : "created"} ${code}`);
  created++;
}
console.log(`\nDone: ${created} created, ${skipped} skipped.`);
process.exit(0);
