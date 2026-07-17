export interface BillableTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

type TokenPrices = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

// Provider list prices in USD per 1,000,000 tokens. Keep this table current as models change.
const PRICE_PREFIXES: ReadonlyArray<readonly [prefix: string, prices: TokenPrices]> = [
  ['claude-sonnet-4', { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 }],
  ['claude-haiku-4-5', { input: 1.00, output: 5.00, cacheWrite: 1.25, cacheRead: 0.10 }],
  ['voyage-3', { input: 0.06, output: 0, cacheWrite: 0, cacheRead: 0 }],
];

export function estimateCostUsd(model: string, u: BillableTokenUsage): number | null {
  const match = PRICE_PREFIXES.find(([prefix]) => model.startsWith(prefix));
  if (!match) return null;
  const p = match[1];
  return (
    u.inputTokens * p.input
    + u.outputTokens * p.output
    + u.cacheReadTokens * p.cacheRead
    + u.cacheWriteTokens * p.cacheWrite
  ) / 1_000_000;
}
