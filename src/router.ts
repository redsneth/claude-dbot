import { donorsFor, getCooldown, getMaxTier, hasToken } from "./db.js";
import { ModelKey, policyAllows } from "./models.js";

export interface Candidate {
  ownerId: string;
  /** true when the requesting user is spending their own quota */
  isOwn: boolean;
}

/**
 * Tokens user `userId` may spend for the requested model, in routing order:
 * their own token first, then donors (least-recently-used first).
 * Excluded: tokens cooling down after a rate limit, and donor tokens whose
 * model policy (max tier) doesn't allow the requested model. A user's own
 * token is never policy-filtered — the policy governs what *others* may run.
 */
export function candidatesFor(userId: string, model?: ModelKey): Candidate[] {
  const out: Candidate[] = [];
  if (hasToken(userId) && !getCooldown(userId)) out.push({ ownerId: userId, isOwn: true });
  for (const ownerId of donorsFor(userId)) {
    if (getCooldown(ownerId)) continue;
    if (model && !policyAllows(getMaxTier(ownerId), model)) continue;
    out.push({ ownerId, isOwn: false });
  }
  return out;
}

export type SubPreference = "auto" | "mine" | "donated";

/** Narrow the candidate list to the user's routing preference. */
export function applySubPreference(candidates: Candidate[], pref: SubPreference): Candidate[] {
  if (pref === "mine") return candidates.filter((c) => c.isOwn);
  if (pref === "donated") return candidates.filter((c) => !c.isOwn);
  return candidates;
}

/** Earliest cooldown expiry among the user's tokens, for "try again at …" messages. */
export function earliestReset(userId: string): number | undefined {
  const owners = [userId, ...donorsFor(userId)];
  const times = owners
    .map((o) => getCooldown(o)?.until)
    .filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : undefined;
}
