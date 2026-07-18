import type { Prisma } from '@prisma/client';

import { GROUP_COMPANY_CODES } from '../companies.js';

export const LEDGER_COMPANY_CODES = ['APPT', ...GROUP_COMPANY_CODES] as const;
export type LedgerCompanyCode = (typeof LEDGER_COMPANY_CODES)[number];

export const LEDGER_MODES = ['cockpit', 'shadow', 'book_of_record', 'paper_only'] as const;
export type LedgerMode = (typeof LEDGER_MODES)[number];

export const JOURNAL_ENTRY_STATES = ['draft', 'posted', 'void'] as const;
export type JournalEntryState = (typeof JOURNAL_ENTRY_STATES)[number];

export interface LedgerActor {
  id?: string;
  name?: string;
  requestId?: string;
}

export interface DraftLineInput {
  lineNo: number;
  accountId: string;
  partnerId?: string | null;
  label?: string;
  debit: string;
  credit: string;
  taxes?: Array<{
    taxId: string;
    role?: 'applied' | 'tax_line';
    baseAmount?: string | null;
    taxAmount?: string | null;
  }>;
}

export interface NormalizedDraftLine extends Omit<DraftLineInput, 'debit' | 'credit'> {
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

export interface DraftValidationResult {
  lines: NormalizedDraftLine[];
  debitTotal: Prisma.Decimal;
  creditTotal: Prisma.Decimal;
}

export type LedgerPostingErrorCode =
  | 'entry_not_found'
  | 'entry_not_draft'
  | 'entry_not_posted'
  | 'entry_already_reversed'
  | 'invalid_entry_date'
  | 'invalid_line'
  | 'invalid_reference'
  | 'unbalanced_entry'
  | 'lock_date_violation'
  | 'paper_only_company'
  | 'reason_required'
  | 'stale_version'
  | 'posted_source_conflict';
