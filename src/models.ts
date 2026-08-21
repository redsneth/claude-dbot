/**
 * Model menu. Higher tier = more capable and burns subscription quota faster.
 * A donor's `max_tier` policy caps which tiers their sub may be used with.
 */
export const MODELS = {
  haiku: { id: "claude-haiku-4-5", tier: 0, label: "Haiku 4.5" },
  sonnet: { id: "claude-sonnet-5", tier: 1, label: "Sonnet 5" },
  opus: { id: "claude-opus-5", tier: 2, label: "Opus 5" },
  fable: { id: "claude-fable-5", tier: 3, label: "Fable 5" },
} as const;

export type ModelKey = keyof typeof MODELS;

export function isModelKey(s: string): s is ModelKey {
  return s in MODELS;
}

/** Whether a token with the given policy ('any' or a ModelKey cap) may run the requested model. */
export function policyAllows(maxTier: string, requested: ModelKey): boolean {
  if (maxTier === "any" || !isModelKey(maxTier)) return true;
  return MODELS[maxTier].tier >= MODELS[requested].tier;
}
