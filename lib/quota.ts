// Shared generation-quota logic for BOTH platforms' server routes.
// One linked Firebase account (uid) = one budget, everywhere:
//   free                 → 1 generation, lifetime
//   individual / weekly  → 5 generations per day
//   family (+ legacy)    → 15 generations per day
// All writes go to generationQuota/{uid} via the Admin SDK (trusted).
import { getFirestore } from "firebase-admin/firestore";

export const GENERATION_LIMITS = { individual: 5, family: 15 } as const;

type Subs = Record<string, { active?: boolean } | undefined>;

export type PlanKind = "free" | "individual" | "family";

/** Plan classification from the shared subscription mirror — identical
 *  semantics for web (Stripe) and iOS (StoreKit) mirror writes. */
export function planFromSubscriptions(subs: Subs): PlanKind {
  if (subs.family_yearly?.active) return "family";
  // Legacy plans are grandfathered to family-level budgets.
  if (subs.yearly?.active || subs.monthly?.active || subs.yearlyOffer?.active) return "family";
  if (subs.individual_yearly?.active || subs.weekly?.active) return "individual";
  return "free";
}

const today = () => new Date().toISOString().split("T")[0];

/**
 * Meters one generation. `setId` lets a client that fans a single
 * generation into multiple requests (the web fires note+flashcard+quiz in
 * parallel) pay exactly one unit: the first request of a set increments,
 * its siblings are recognized and free. Direct callers without a setId
 * pay one unit per call.
 */
export async function meterGeneration(
  uid: string,
  setId?: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const db = getFirestore();
  const quotaRef = db.collection("generationQuota").doc(uid);

  const userSnap = await db.collection("users").doc(uid).get();
  const subs = (userSnap.data()?.subscriptions ?? {}) as Subs;
  const plan = planFromSubscriptions(subs);

  const snap = await quotaRef.get();
  const data = snap.data() as
    | { date?: string; used?: number; freeUsed?: boolean; recentSets?: string[] }
    | undefined;
  const isToday = data?.date === today();

  // Same-generation siblings (web trio) — already counted.
  if (setId && isToday && (data?.recentSets ?? []).includes(setId)) {
    return { ok: true };
  }

  if (plan === "free") {
    if (data?.freeUsed) {
      return {
        ok: false,
        status: 429,
        message: "Your free note has been used. Upgrade to keep generating.",
      };
    }
    await quotaRef.set(
      {
        date: today(),
        used: (isToday ? data?.used ?? 0 : 0) + 1,
        freeUsed: true,
        ...(setId && { recentSets: [setId] }),
      },
      { merge: true }
    );
    return { ok: true };
  }

  const limit = plan === "family" ? GENERATION_LIMITS.family : GENERATION_LIMITS.individual;
  const used = isToday ? data?.used ?? 0 : 0;
  if (used >= limit) {
    return {
      ok: false,
      status: 429,
      message: `Daily limit reached (${limit} generations per day). Resets at midnight.`,
    };
  }

  await quotaRef.set(
    {
      date: today(),
      used: used + 1,
      ...(setId && {
        recentSets: [...(isToday ? data?.recentSets ?? [] : []), setId].slice(-10),
      }),
    },
    { merge: true }
  );
  return { ok: true };
}
