// Punch #9 — canonical customer identity backfill.
//
// Populates the Party + PartyIdentity spine (prisma/schema.prisma) from the four
// customer-shaped source tables that today fork one real entity across unlinked rows:
//   Customer      (LINE)     → line_user  (+ express_code if a code was staff-assigned)
//   VenusCustomer (Express)  → express_code
//   ClinicAccount (Diana)    → diana_email (+ express_code bridge from customerCode)
//   OaReadSync    (OA)       → oa_chat     (attached to the matched Customer's party)
//   CeresParty    (Ceres)    → ceres_name  (+ agent_email)
//
// Design (see schema §Party header):
//   - Run-once, NOT a boot step. DRY-RUN by default; `--apply` writes.
//   - Idempotent: every (channel,key) is looked up before insert, so a re-run reuses
//     the existing Party and never duplicates. Idempotency comes from the find-first
//     logic + the @@unique([channel,key]) constraint, NOT from a wrapping transaction
//     (the base client is used directly so a caught P2002 race can safely re-read; a
//     single interactive tx over ~10k Venus rows would time out and, once aborted,
//     could not continue after a caught error).
//   - NON-INVASIVE: only Party/PartyIdentity are written. No partyId columns are added
//     to source tables; no boot/seed/business logic is touched.
//   - CONSERVATIVE: if a key already belongs to a DIFFERENT party, we do NOT auto-merge —
//     the collision is counted + logged for human review and the run continues.
//
//   Usage:
//     npx tsx src/scripts/backfillParties.ts            # dry-run: compute + print summary, write nothing
//     npx tsx src/scripts/backfillParties.ts --apply    # write Party + PartyIdentity rows

import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

// ─── Normaliser ──────────────────────────────────────────────────────────────
// express_code reuses venus.ts `toSearchKey` (lowercase + strip everything but
// alnum/Thai) EXACTLY, then additionally folds Thai digits ๐-๙ → 0-9 so that
// "๙๙0000006" and "990000006" collapse to one key. See SKU dash-insensitive doc.
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
function foldThaiDigits(s: string): string {
  return s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}
// Verbatim copy of api/src/routes/venus.ts toSearchKey (keep in sync).
function toSearchKey(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-z฀-๿]/g, '');
}

/**
 * Normalise a raw external key for a channel. Returns '' for empty/blank input —
 * callers MUST treat '' as "no key" and never create an identity for it.
 */
export function normalize(channel: string, raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  switch (channel) {
    case 'express_code':
      return foldThaiDigits(toSearchKey(s));
    case 'diana_email':
    case 'agent_email':
      return s.toLowerCase();
    case 'phone':
      return s.replace(/\D/g, '');
    default:
      // line_user | oa_chat | ceres_name | vendor_local | anything else → trimmed as-is
      return s;
  }
}

// ─── Run state (module-scoped so the named helpers keep the spec'd signatures) ─
type Mode = 'dry' | 'apply';
type PartyDefaults = Omit<Prisma.PartyCreateInput, 'identities'>;

interface Conflict {
  channel: string;
  key: string;
  existingPartyId: string;
  wantedPartyId: string;
  source: string;
}

interface RunState {
  mode: Mode;
  // "channel\x00key" → partyId (real cuid in apply mode; "virt-N" placeholder in dry-run).
  // Seeded from existing PartyIdentity rows so a re-run is a no-op / idempotent.
  index: Map<string, string>;
  virt: number;
  partiesCreated: number;
  identitiesCreated: Record<string, number>; // by channel
  identitiesReused: number;
  conflicts: Conflict[];
}

let run: RunState;

const idxKeyOf = (channel: string, key: string) => `${channel}\x00${key}`;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

function bumpChannel(channel: string): void {
  run.identitiesCreated[channel] = (run.identitiesCreated[channel] ?? 0) + 1;
}

// ─── Core helpers ──────────────────────────────────────────────────────────────
/**
 * Resolve (or create) the Party that owns (channel, normalize(rawKey)).
 *  - key === ''            → returns null (never link an empty key)
 *  - identity already seen → returns its partyId (IDEMPOTENT reuse)
 *  - otherwise             → creates a Party (partyDefaults) + this PartyIdentity(rawKey=raw)
 * The unique-violation race is caught → re-read the identity and reuse its party.
 */
async function linkIdentity(
  tx: Prisma.TransactionClient,
  channel: string,
  rawKey: string | null | undefined,
  partyDefaults: PartyDefaults,
  source: string,
  confidence: string = 'confirmed',
): Promise<string | null> {
  const key = normalize(channel, rawKey);
  if (key === '') return null;

  const ik = idxKeyOf(channel, key);
  const seen = run.index.get(ik);
  if (seen) {
    run.identitiesReused++;
    return seen;
  }

  if (run.mode === 'dry') {
    const virt = `virt-${++run.virt}`;
    run.index.set(ik, virt);
    run.partiesCreated++;
    bumpChannel(channel);
    return virt;
  }

  try {
    const party = await tx.party.create({
      data: {
        ...partyDefaults,
        identities: {
          create: { channel, key, rawKey: (rawKey ?? '').trim(), confidence, source },
        },
      },
    });
    run.index.set(ik, party.id);
    run.partiesCreated++;
    bumpChannel(channel);
    return party.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const found = await tx.partyIdentity.findUnique({ where: { channel_key: { channel, key } } });
      if (found) {
        run.index.set(ik, found.partyId);
        run.identitiesReused++;
        return found.partyId;
      }
    }
    throw e;
  }
}

/**
 * Attach an ADDITIONAL identity onto a KNOWN party (the "…ALSO channel onto the SAME
 * party" bridges). Idempotent when the key is already on this party. If the key already
 * belongs to a DIFFERENT party → NOT merged: counted + logged as a conflict, run continues.
 */
async function attachIdentity(
  tx: Prisma.TransactionClient,
  partyId: string,
  channel: string,
  rawKey: string | null | undefined,
  source: string,
  confidence: string = 'confirmed',
): Promise<void> {
  const key = normalize(channel, rawKey);
  if (key === '') return;

  const ik = idxKeyOf(channel, key);
  const seen = run.index.get(ik);
  if (seen) {
    if (seen === partyId) {
      run.identitiesReused++;
      return;
    }
    // Same (channel,key) already points at a different party → conflict, do not auto-merge.
    recordConflict(channel, key, seen, partyId, source);
    return;
  }

  if (run.mode === 'dry') {
    run.index.set(ik, partyId);
    bumpChannel(channel);
    return;
  }

  try {
    await tx.partyIdentity.create({
      data: { partyId, channel, key, rawKey: (rawKey ?? '').trim(), confidence, source },
    });
    run.index.set(ik, partyId);
    bumpChannel(channel);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const found = await tx.partyIdentity.findUnique({ where: { channel_key: { channel, key } } });
      if (found) {
        run.index.set(ik, found.partyId);
        if (found.partyId !== partyId) recordConflict(channel, key, found.partyId, partyId, source);
        else run.identitiesReused++;
        return;
      }
    }
    throw e;
  }
}

function recordConflict(
  channel: string,
  key: string,
  existingPartyId: string,
  wantedPartyId: string,
  source: string,
): void {
  run.conflicts.push({ channel, key, existingPartyId, wantedPartyId, source });
  console.warn(
    `CONFLICT [${source}] ${channel}/${key} already belongs to party ${existingPartyId}; ` +
      `not merging with ${wantedPartyId} (recorded confidence='conflict')`,
  );
}

// ─── Backfill sources (run in order; later sources may merge onto earlier parties) ──
async function backfill(tx: Prisma.TransactionClient): Promise<void> {
  // 1. Customer → line_user (+ express_code onto the SAME party when a code is set).
  const custIdToLineUser = new Map<string, string>();
  const customers = await tx.customer.findMany({
    select: { id: true, lineUserId: true, displayName: true, nickname: true, code: true },
  });
  for (const c of customers) {
    custIdToLineUser.set(c.id, c.lineUserId);
    const displayName = c.nickname || c.displayName || '';
    const pid = await linkIdentity(
      tx,
      'line_user',
      c.lineUserId,
      { kind: 'customer', displayName },
      'customer',
    );
    if (pid && normalize('express_code', c.code) !== '') {
      await attachIdentity(tx, pid, 'express_code', c.code, 'customer');
    }
  }

  // 2. VenusCustomer → express_code (attaches to the Customer's party when the code
  //    already exists; else a fresh party keyed by name/phone).
  const venus = await tx.venusCustomer.findMany({
    select: { code: true, name: true, phone: true },
  });
  for (const v of venus) {
    await linkIdentity(
      tx,
      'express_code',
      v.code,
      { kind: 'customer', displayName: v.name || '', primaryPhone: v.phone ?? '' },
      'venus',
    );
  }

  // 3. ClinicAccount → diana_email (+ express_code bridge from customerCode; may merge).
  //    Email is NEVER merged with LINE — only the explicit customerCode bridges channels.
  const clinics = await tx.clinicAccount.findMany({
    select: { email: true, clinicName: true, phone: true, customerCode: true },
  });
  for (const a of clinics) {
    const pid = await linkIdentity(
      tx,
      'diana_email',
      a.email,
      { kind: 'customer', displayName: a.clinicName || '', primaryPhone: a.phone ?? '' },
      'diana',
    );
    if (pid && normalize('express_code', a.customerCode) !== '') {
      // Intended cross-channel bridge; conservative — flagged as a conflict if the code
      // already anchors a different (LINE/Express) party rather than silently merging.
      await attachIdentity(tx, pid, 'express_code', a.customerCode, 'diana');
    }
  }

  // 4. OaReadSync (customerId != null) → oa_chat onto that Customer's party. Skip nulls.
  const oa = await tx.oaReadSync.findMany({
    where: { customerId: { not: null } },
    select: { oaChatId: true, customerId: true },
  });
  for (const o of oa) {
    const lineUserId = o.customerId ? custIdToLineUser.get(o.customerId) : undefined;
    if (!lineUserId) {
      console.warn(`SKIP oa_chat ${o.oaChatId}: customerId ${o.customerId} has no backfilled Customer party`);
      continue;
    }
    const pid = run.index.get(idxKeyOf('line_user', normalize('line_user', lineUserId)));
    if (!pid) {
      console.warn(`SKIP oa_chat ${o.oaChatId}: no line_user party for customer ${o.customerId}`);
      continue;
    }
    await attachIdentity(tx, pid, 'oa_chat', o.oaChatId, 'oa');
  }

  // 5. CeresParty → ceres_name (+ agent_email). kind: carrier stays carrier, else payee.
  const ceres = await tx.ceresParty.findMany({
    select: { name: true, kind: true, agentEmail: true },
  });
  for (const p of ceres) {
    const kind = p.kind === 'carrier' ? 'carrier' : 'payee';
    const pid = await linkIdentity(
      tx,
      'ceres_name',
      p.name,
      { kind, displayName: p.name || '' },
      'ceres',
    );
    if (pid && normalize('agent_email', p.agentEmail) !== '') {
      await attachIdentity(tx, pid, 'agent_email', p.agentEmail, 'ceres');
    }
  }
}

// ─── Entry point ───────────────────────────────────────────────────────────────
function printSummary(): void {
  const totalIdentities = Object.values(run.identitiesCreated).reduce((a, b) => a + b, 0);
  console.log('');
  console.log(`=== backfillParties summary (${run.mode === 'dry' ? 'DRY-RUN — nothing written' : 'APPLIED'}) ===`);
  console.log(`Parties ${run.mode === 'dry' ? 'to create' : 'created'}:        ${run.partiesCreated}`);
  console.log(`Identities ${run.mode === 'dry' ? 'to create' : 'created'}:     ${totalIdentities}`);
  const channels = Object.keys(run.identitiesCreated).sort();
  for (const ch of channels) {
    console.log(`    ${ch.padEnd(14)} ${run.identitiesCreated[ch]}`);
  }
  console.log(`Identities reused (already present): ${run.identitiesReused}`);
  console.log(`Conflicts (NOT merged, need review): ${run.conflicts.length}`);
  for (const c of run.conflicts) {
    console.log(`    ${c.channel}/${c.key}  existing=${c.existingPartyId}  wanted=${c.wantedPartyId}  [${c.source}]`);
  }
  if (run.mode === 'dry') console.log('\nRe-run with --apply to write these rows.');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  run = {
    mode: apply ? 'apply' : 'dry',
    index: new Map(),
    virt: 0,
    partiesCreated: 0,
    identitiesCreated: {},
    identitiesReused: 0,
    conflicts: [],
  };

  console.log(`backfillParties starting in ${run.mode === 'apply' ? 'APPLY' : 'DRY-RUN'} mode…`);

  // Seed the in-memory index from any identities already present → idempotent re-runs
  // and a dry-run that reports only the DELTA still to be written.
  const existing = await prisma.partyIdentity.findMany({
    select: { channel: true, key: true, partyId: true },
  });
  for (const r of existing) run.index.set(idxKeyOf(r.channel, r.key), r.partyId);
  console.log(`Seeded ${existing.length} existing PartyIdentity rows.`);

  await backfill(prisma);
  printSummary();
}

// Only self-run when invoked directly (so importing normalize() in tests never hits the DB).
// Compare real filesystem paths (robust on Windows/tsx); fall back to a basename match.
const argvPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const isMain = !!argvPath && (argvPath === selfPath || /\/backfillParties\.(ts|js)$/.test(argvPath));

if (isMain) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
