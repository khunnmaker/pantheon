// FIN-declared per-XS amount (owner ruling 2026-07-21, see docs/JUNO_XS_AMOUNTS_PLAN.md): the
// STTRNR6.TXT import's `amount` is the raw report sum and is NOT trusted money-of-record for XS
// docs — FIN types the real figure either while checking a payment that carries an XS chip
// (POST /api/juno/payments/:id/verify) or directly from the XS tab
// (POST /api/juno/xs/:xsNo/amount). Both routes persist through this ONE helper so the upsert
// shape can never drift between them.
import { Prisma } from '@prisma/client';

export type XsAmountTx = Prisma.TransactionClient;

/**
 * Upsert XsDoc.confirmedAmount(+At/+By) by xsNo. The UPDATE branch touches ONLY the confirmed-*
 * fields — never docDate/note/amount/importedAt (those stay owned by the STTRNR6.TXT import).
 * The CREATE branch makes a stub row (docDate/note/amount '') for a confirm that arrives before
 * the doc is ever imported — the import's own upsert later fills the report fields in without
 * touching these (see its UPDATE branch).
 */
export async function upsertXsConfirmedAmount(
  tx: XsAmountTx,
  xsNo: string,
  amount: string,
  actor: string,
  now: Date,
) {
  return tx.xsDoc.upsert({
    where: { xsNo },
    create: {
      xsNo, docDate: '', note: '', amount: '',
      confirmedAmount: amount, confirmedAmountAt: now, confirmedAmountBy: actor,
    },
    update: {
      confirmedAmount: amount, confirmedAmountAt: now, confirmedAmountBy: actor,
    },
  });
}
