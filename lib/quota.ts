// Cross-platform generation quota — NO SERVICE ACCOUNT.
//
// The caller's own Firebase ID token authorizes every read AND write via
// Firestore's REST API, under generationQuota rules that make the counter
// tamper-proof: used may only rise by ≤1 per write (or restart on a true
// date rollover anchored to server time), chatUsed likewise, freeUsed may
// only flip on, deletes never. A fully reverse-engineered client can
// therefore read its own budget but cannot reset, decrement, or jump the
// date ahead — the database refuses.
//
// Budgets (identical for web + iOS, from the shared subscription mirror):
//   free → 1 generation, lifetime · individual/weekly → 5/day · family (+legacy) → 15/day
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const today = () => new Date().toISOString().split("T")[0];

type Subs = Record<string, { active?: boolean } | undefined>;
export type PlanKind = "free" | "individual" | "family";

export const GENERATION_LIMITS = { individual: 5, family: 15 } as const;

export function planFromSubscriptions(subs: Subs): PlanKind {
  if (subs.family_yearly?.active) return "family";
  if (subs.yearly?.active || subs.monthly?.active || subs.yearlyOffer?.active) return "family";
  if (subs.individual_yearly?.active || subs.weekly?.active) return "individual";
  return "free";
}

interface QuotaDoc {
  date?: string;
  used?: number;
  chatUsed?: number;
  freeUsed?: boolean;
  recentSets?: string[];
  updateTime?: string;
}

function toValue(v: unknown): unknown {
  if (typeof v === "number") return { integerValue: String(v) };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  return { stringValue: String(v ?? "") };
}

async function restGet(path: string, token: string): Promise<any | null> {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return response.json();
}

function parseDoc(fields: Record<string, any> | undefined, updateTime?: string): QuotaDoc {
  if (!fields) return { updateTime };
  const out: QuotaDoc = { updateTime };
  if (fields.date?.stringValue) out.date = fields.date.stringValue;
  if (fields.used?.integerValue) out.used = parseInt(fields.used.integerValue, 10);
  if (fields.chatUsed?.integerValue) out.chatUsed = parseInt(fields.chatUsed.integerValue, 10);
  if (typeof fields.freeUsed?.booleanValue === "boolean") out.freeUsed = fields.freeUsed.booleanValue;
  if (fields.recentSets?.arrayValue?.values) {
    out.recentSets = fields.recentSets.arrayValue.values.map((v: any) => v.stringValue);
  }
  return out;
}

async function restPatch(
  path: string,
  token: string,
  data: Record<string, unknown>,
  updateTime?: string
): Promise<boolean> {
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  const precondition = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : "";
  const response = await fetch(`${FIRESTORE_BASE}/${path}?${mask}${precondition}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }),
  });
  return response.ok;
}

async function readPlan(token: string, uid: string): Promise<PlanKind> {
  const user = await restGet(`users/${uid}`, token);
  const subs: any = user?.fields?.subscriptions?.mapValue?.fields ?? {};
  const parsed: Subs = {};
  for (const [key, value] of Object.entries(subs)) {
    parsed[key] = { active: (value as any)?.mapValue?.fields?.active?.booleanValue === true };
  }
  return planFromSubscriptions(parsed);
}

async function getQuota(token: string, uid: string): Promise<QuotaDoc | null> {
  const doc = await restGet(`generationQuota/${uid}`, token);
  return parseDoc(doc?.fields, doc?.updateTime);
}

export type QuotaResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Meters one generation. `setId` lets a client that fans one generation
 * into multiple requests (the web's note+flashcards+quiz trio) pay one
 * unit: the first sibling increments, the rest are recognized and free.
 */
export async function meterGeneration(
  token: string,
  uid: string,
  setId?: string
): Promise<QuotaResult> {
  const plan = await readPlan(token, uid);
  const quota = (await getQuota(token, uid)) ?? {};
  const isToday = quota.date === today();

  if (setId && isToday && (quota.recentSets ?? []).includes(setId)) {
    return { ok: true };
  }

  if (plan === "free") {
    if (quota.freeUsed) {
      return { ok: false, status: 429, message: "Your free note has been used. Upgrade to keep generating." };
    }
    const write = await restPatch(`generationQuota/${uid}`, token, {
      date: today(),
      used: isToday ? (quota.used ?? 0) + 1 : 1,
      freeUsed: true,
      ...(setId && { recentSets: [setId] }),
    }, quota.updateTime);
    return write ? { ok: true } : { ok: false, status: 500, message: "Quota update conflict, try again." };
  }

  const limit = plan === "family" ? GENERATION_LIMITS.family : GENERATION_LIMITS.individual;
  const used = isToday ? quota.used ?? 0 : 0;
  if (used >= limit) {
    return { ok: false, status: 429, message: `Daily limit reached (${limit} generations per day). Resets at midnight.` };
  }

  const write = await restPatch(`generationQuota/${uid}`, token, {
    date: today(),
    used: used + 1,
    ...(setId && { recentSets: [...(isToday ? quota.recentSets ?? [] : []), setId].slice(-10) }),
  }, quota.updateTime);

  return write ? { ok: true } : { ok: false, status: 500, message: "Quota update conflict, try again." };
}

/** Chat/onboarding bucket: generous daily cap, separate from generations. */
export async function meterChat(token: string, uid: string): Promise<QuotaResult> {
  const quota = (await getQuota(token, uid)) ?? {};
  const isToday = quota.date === today();
  const used = isToday ? quota.chatUsed ?? 0 : 0;
  if (used >= 100) {
    return { ok: false, status: 429, message: "Daily limit reached. Try again tomorrow." };
  }
  const write = await restPatch(`generationQuota/${uid}`, token, {
    date: today(),
    chatUsed: used + 1,
  }, quota.updateTime);
  return write ? { ok: true } : { ok: false, status: 500, message: "Quota update conflict, try again." };
}
