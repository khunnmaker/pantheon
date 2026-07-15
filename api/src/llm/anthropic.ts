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

// Cache observability: token breakdown of the most recent call, and a per-call log line so
// hit rates are visible in the deploy logs (docs: "regularly analyze cache hit rates").
// A healthy warm call shows a large cacheRead and a small uncachedIn; cacheRead stuck at 0
// means the prefix is silently NOT caching (below the model's minimum, or byte-unstable).
export interface CacheStats {
  uncachedIn: number; // input tokens after the last cache breakpoint (billed full price)
  cacheRead: number; // tokens read from cache (billed ~10%)
  cacheWrite: number; // tokens written to cache (billed 125%)
  out: number;
}
let lastCacheStats: CacheStats | null = null;
export function getLastCacheStats(): CacheStats | null {
  return lastCacheStats;
}

function recordUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): void {
  lastCacheStats = {
    uncachedIn: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    out: usage.output_tokens,
  };
  // eslint-disable-next-line no-console
  console.log(
    `[llm] in=${lastCacheStats.uncachedIn} cache_read=${lastCacheStats.cacheRead} cache_write=${lastCacheStats.cacheWrite} out=${lastCacheStats.out}`,
  );
}

// Single-shot completion. Optional system prompt keeps trusted rules separate
// from untrusted user/customer content. Throws if no key or the API errors —
// callers wrap in try/catch and safe-default to needs_human.
export async function callClaude(
  user: string,
  system?: SystemPrompt,
  maxTokens = MAX_TOKENS,
  model: string = MODEL, // optional override; defaults to the shared drafting model
): Promise<string> {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await c.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system: buildSystemBlocks(system) } : {}),
    messages: [{ role: 'user', content: user }],
  });

  recordUsage(res.usage);
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
  return callClaudeWithImages(userText, system, [image], maxTokens);
}

// Vision completion with multiple images. Images stay in caller-provided order
// (the draft pipeline supplies them oldest-first), followed by the text block.
export async function callClaudeWithImages(
  userText: string,
  system: SystemPrompt,
  images: { base64: string; mediaType: string }[],
  maxTokens = MAX_TOKENS,
): Promise<string> {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: buildSystemBlocks(system),
    messages: [
      {
        role: 'user',
        content: [
          // PDFs ride the same reader as images: Claude takes application/pdf natively as a
          // `document` content block (base64 source, no beta header) — bank apps export slips
          // as PDF, so Juno's manual-add OCR must accept both. Anything that is neither a
          // supported raster nor a PDF still coerces to image/jpeg (legacy: uploads that
          // arrived without a contentType are stored application/octet-stream but ARE jpegs).
          ...images.map((image) =>
            image.mediaType === 'application/pdf'
              ? {
                  type: 'document' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'application/pdf' as const,
                    data: image.base64,
                  },
                }
              : {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: (SUPPORTED_IMAGE_TYPES.includes(image.mediaType)
                      ? image.mediaType
                      : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                    data: image.base64,
                  },
                },
          ),
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  recordUsage(res.usage);
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
