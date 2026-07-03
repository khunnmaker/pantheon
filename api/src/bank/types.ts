// Shared shapes for the two bank-file parsers (parseKbiz.ts / parseKshop.ts). Both files
// arrive from the owner's Wed/Sat downloads and get imported via the preview→apply flow
// in routes/juno.ts (see JUNO_PROCESS_BRIEF.md PHASE B).

export type BankSource = 'kbiz' | 'kshop';
export type BankDirection = 'in' | 'out';

// One parsed bank line, prior to dedupeKey computation (that's added by the caller since
// it depends on the source string, which the row itself doesn't carry).
export interface ParsedBankRow {
  txnAt: Date; // built with an explicit +07:00 offset regardless of server TZ
  amount: string; // baht "1234.56" — always positive; direction carries the sign meaning
  direction: BankDirection;
  channel: string;
  description: string; // KBIZ Descriptions / K SHOP "Payment"/"Void"
  details: string; // KBIZ Details / K SHOP payer·bank·terminal (composed by the parser)
  payerName: string;
  payerBank: string;
}

export interface ParsedBankFile {
  source: BankSource;
  rows: ParsedBankRow[];
  parsed: number; // total data rows seen (rows.length + excluded)
  excluded: number; // K SHOP settlement lump / Void rows / balance rows, NOT returned in rows
  periodFrom: Date | null;
  periodTo: Date | null;
}

export class BankParseError extends Error {}
