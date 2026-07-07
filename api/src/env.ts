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
  // Set to "1"/"true" to never actually push to LINE (testing/staging safety).
  LINE_DRY_RUN: z.string().default(''),

  // Pipeline tuning (spec §13).
  RECENT_WINDOW: z.coerce.number().int().positive().default(10),
  RETRIEVE_K: z.coerce.number().int().positive().default(3),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  DRAFT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(15000), // burst debounce: wait this long after the LAST message before drafting (0 = draft immediately)
  KB_INJECT_ALL_MAX: z.coerce.number().int().positive().default(120),
  PICTURE_REFRESH_DAYS: z.coerce.number().int().positive().default(7), // staleness window: re-fetch a customer's LINE picture at most once per this many days

  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  // Suite-wide SSO (Jupiter Phase 3): parent domain for the shared session cookie, e.g.
  // ".prominentdental.com" (leading dot = all subdomains). Set on the PRODUCTION api so the
  // login cookie is shared across every *.prominentdental.com app. Unset (local/dev) →
  // host-only cookie, no cross-subdomain SSO. See api/src/auth/cookies.ts.
  COOKIE_DOMAIN: z.string().default(''),

  // Unified auth: all 15 employees' 6-digit PINs, "slug:pin,slug:pin" (slug = EMPLOYEES entry).
  EMPLOYEE_PINS: z.string().default(''),
  // Unified auth: Nee's (MD) password.
  MD_PASSWORD: z.string().default(''),

  // Where customer images are stored. In prod set this to a mounted persistent
  // volume path (e.g. /data); defaults to ./uploads for local dev.
  UPLOAD_DIR: z.string().default(''),

  // Finance "แจ้งการเงิน" → Google Sheet via an Apps Script web-app webhook + shared secret.
  FINANCE_SHEET_WEBHOOK: z.string().default(''),
  FINANCE_SHEET_SECRET: z.string().default(''),

  // Ceres (expenses & petty cash) — see docs/CERES_BRIEF.md.
  // Deprecated fallback (unified auth) — superseded by EMPLOYEE_PINS; remove after cutover.
  CERES_MESSENGER_PINS: z.string().default(''),   // "ta:123456,arm:234567,…" slug:pin pairs
  CERES_FLOOR: z.coerce.number().default(40000),
  CERES_CEO_THRESHOLD: z.coerce.number().default(5000),
  // Hour (0-23, Thai local time) the nightly CEO digest fires — see ceres/nightlyDigest.ts.
  CERES_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(21),

  // Suite-wide: the CEO's LINE userId for push alerts (Ceres escalations today; any
  // deity may reuse it). CERES_CEO_LINE_USER_ID is a deprecated fallback (remove after cutover).
  CEO_LINE_USER_ID: z.string().default(''),
  CERES_CEO_LINE_USER_ID: z.string().default(''),
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
