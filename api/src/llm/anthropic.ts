import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
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

// A system prompt is either a plain string (unchanged behavior) or split into stable/
// cacheable prefix blocks + an optional per-call variable suffix. Drafts fire every few
// seconds during business hours, so the cached blocks (rules, KB) stay warm well inside
// Anthropic's 5-min TTL — cache READS bill at ~10% of normal input token price, so marking
// the byte-identical rules+KB prefix is most of this system's cost win.
export type SystemPrompt = string | { cached: string[]; variable?: string };

function buildSystemBlocks(system: SystemPrompt): string | TextBlockParam[] {
  if (typeof system === 'string') return system;
  const blocks: TextBlockParam[] = system.cached.map((text) => ({
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  }));
  // Only append when non-empty — the API rejects empty text blocks.
  if (system.variable) blocks.push({ type: 'text', text: system.variable });
  return blocks;
}

// Single-shot completion. Optional system prompt keeps trusted rules separate
// from untrusted user/customer content. Throws if no key or the API errors —
// callers wrap in try/catch and safe-default to needs_human.
export async function callClaude(
  user: string,
  system?: SystemPrompt,
  maxTokens = MAX_TOKENS,
): Promise<string> {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(system ? { system: buildSystemBlocks(system) } : {}),
    messages: [{ role: 'user', content: user }],
  });

  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Vision completion: same as callClaude but with an image attached to the user
// turn so the model can read/understand a customer photo.
export async function callClaudeWithImage(
  userText: string,
  system: SystemPrompt,
  image: { base64: string; mediaType: string },
  maxTokens = MAX_TOKENS,
): Promise<string> {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const mediaType = SUPPORTED_IMAGE_TYPES.includes(image.mediaType)
    ? (image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
    : 'image/jpeg';

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: buildSystemBlocks(system),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.base64 } },
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
