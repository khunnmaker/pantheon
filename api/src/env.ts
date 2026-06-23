import 'dotenv/config';
import { z } from 'zod';

// Validate and type all env up front. Keys that aren't needed until later
// milestones (LINE / Anthropic / Voyage) are optional and default to "".
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),

  // Needed M2 / M3 — optional at M0/M1.
  ANTHROPIC_API_KEY: z.string().default(''),
  VOYAGE_API_KEY: z.string().default(''),

  // Needed M1 webhook / M2 send — optional at M0.
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  LINE_CHANNEL_SECRET: z.string().default(''),

  // Pipeline tuning (spec §13).
  RECENT_WINDOW: z.coerce.number().int().positive().default(10),
  RETRIEVE_K: z.coerce.number().int().positive().default(3),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
