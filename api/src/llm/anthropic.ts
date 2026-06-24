import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';

// Drafting/summarizing model (spec §3/§7).
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export function llmAvailable(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

// Single-shot completion. Optional system prompt keeps trusted rules separate
// from untrusted user/customer content. Throws if no key or the API errors —
// callers wrap in try/catch and safe-default to needs_human.
export async function callClaude(
  user: string,
  system?: string,
  maxTokens = MAX_TOKENS,
): Promise<string> {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
  });

  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
