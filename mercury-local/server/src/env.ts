// Load .env from the mercury-local package root (one level up from server/) BEFORE anything
// reads process.env — Prisma needs DATABASE_URL. Tiny hand-rolled loader (no dotenv dep):
// KEY="value" or KEY=value lines; ignores blanks/#comments; does not override already-set vars.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// server/src (tsx) or server/dist (built) → package root is two levels up in both layouts.
const pkgRoot = resolve(here, '..', '..');

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env — rely on real env / defaults
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(resolve(pkgRoot, '.env'));

// Prisma resolves the sqlite path relative to the schema (prisma/), so a bare relative
// DATABASE_URL works from any cwd. Provide sane defaults so the app runs with no .env.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${resolve(pkgRoot, 'prisma', 'mercury-local.db')}`;
}

export const PORT = Number(process.env.PORT ?? 4610);
export const PKG_ROOT = pkgRoot;
