// Lets a caller "arm" a one-time Anthropic API key for a specific parent's next Claude-touching
// event (wandering triage, FRS review, care-reply parsing), instead of relying on a standing
// ANTHROPIC_API_KEY env var that would spend the operator's credits for anyone who hits the
// public demo endpoints. Armed keys are in-memory only (never persisted/logged), consumed
// exactly once, and expire on their own if nothing ever picks them up.

const pending = new Map(); // parentId -> { key, expiresAt }
const TTL_MS = 5 * 60 * 1000;

export function armAnthropicKey(parentId, apiKey) {
  if (!apiKey) return;
  pending.set(parentId, { key: apiKey, expiresAt: Date.now() + TTL_MS });
}

// Consumes (deletes) the armed key for parentId, if any and not expired. Call this right before
// the Claude call it's meant for — not eagerly — so an unrelated tick doesn't burn an armed key
// on a Claude call the caller never intended it for.
export function takeAnthropicKey(parentId) {
  const entry = pending.get(parentId);
  if (!entry) return undefined;
  pending.delete(parentId);
  return entry.expiresAt >= Date.now() ? entry.key : undefined;
}
