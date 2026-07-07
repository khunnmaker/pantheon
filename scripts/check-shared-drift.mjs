#!/usr/bin/env node
// Guards the frontend files/types that MUST stay identical across the Pantheon apps.
//
// WHY THIS IS A CHECK, NOT A SHARED PACKAGE: each app is its own Docker build whose Railway
// "Root Directory" is the app subdir (Dockerfile does `COPY . .`), so a repo-root shared package
// or `shared/` dir is OUTSIDE every app's build context and can't be imported without flipping
// all 8 services' root dirs + rewriting 8 Dockerfiles (an owner-driven infra cutover). Until then
// these files are physically copied per app — and THIS guard fails CI the moment a copy drifts,
// which is the actual bug class the review flagged (stale Diana Role type, AppName drift, MD-tile
// bug). Run locally: `node scripts/check-shared-drift.mjs`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

let drift = 0;
const fail = (msg) => {
  console.error('DRIFT: ' + msg);
  drift += 1;
};

// 1) Files that must be BYTE-IDENTICAL across these apps (jupiter is excluded — it owns the
//    canonical superset roster.ts and a matching avatar variant).
const IDENTICAL = [
  { file: 'src/lib/avatar.ts', apps: ['web', 'juno', 'vulcan', 'ceres', 'mercury'] },
  { file: 'src/lib/loginGroups.ts', apps: ['web', 'juno', 'vulcan', 'ceres', 'mercury'] },
];
for (const { file, apps } of IDENTICAL) {
  const present = apps.map((a) => ({ a, c: read(`${a}/${file}`) })).filter((x) => x.c !== null);
  if (present.length < 2) continue;
  const base = present[0];
  for (const x of present.slice(1)) {
    if (x.c !== base.c) fail(`${x.a}/${file} differs from ${base.a}/${file} — sync the copies`);
  }
}

// 2) The frontend `AppName` union must not contain a value the server SSOT doesn't
//    (api/src/auth/jwt.ts APP_NAMES). A frontend may legitimately OMIT apps it can't launch, so
//    only EXTRA/unknown values are flagged — that catches a stale union that still lists a removed
//    app, or a typo'd app name.
const serverApps = (() => {
  const src = read('api/src/auth/jwt.ts');
  const m = src && src.match(/APP_NAMES\s*=\s*\[([^\]]+)\]/);
  return m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : null;
})();
const APPNAME_RE = /export type AppName =\s*([^;]+);/;
for (const a of ['web', 'juno', 'vulcan', 'jupiter', 'mercury', 'ceres', 'diana', 'venus']) {
  const src = read(`${a}/src/lib/api.ts`);
  const m = src && src.match(APPNAME_RE);
  if (!m || !serverApps) continue; // app doesn't define AppName locally — fine
  const vals = m[1].split('|').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const unknown = vals.filter((v) => !serverApps.includes(v));
  if (unknown.length) fail(`${a}/src/lib/api.ts AppName lists value(s) not in the server SSOT (api/src/auth/jwt.ts): ${unknown.join(', ')}`);
}

if (drift) {
  console.error(`\n${drift} drift(s) found — reconcile the copies (types SSOT: api/src/auth/jwt.ts).`);
  process.exit(1);
}
console.log('✓ shared frontend files + AppName unions are in sync');
