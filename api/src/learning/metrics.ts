export const EFFECTIVE_ACCEPT_THRESHOLD = 0.9;

export function acceptRate(bucket: { accepted: number; edited: number }): number | null {
  return bucket.accepted + bucket.edited > 0 ? bucket.accepted / (bucket.accepted + bucket.edited) : null;
}

export function effectiveAcceptRate(bucket: { effectiveAccepted: number; accepted: number; edited: number }): number | null {
  return bucket.accepted + bucket.edited > 0
    ? bucket.effectiveAccepted / (bucket.accepted + bucket.edited)
    : null;
}
