import { describe, expect, it } from 'vitest';
import { isAutoRecordEligible, type AutoRecordCandidate } from '../src/finance/autoRecord.js';

// Pure eligibility rules for the automatic stage-4 (ยืนยันใน Express) sweep — owner ruling
// 2026-07-19: Express's *** evidence + money grounding replace the manual weekend press.
const base: AutoRecordCandidate = {
  source: 'line', receivedAt: null, creditUsed: '',
  reNumbers: [], billNos: [], bankMatchCount: 0,
};
const clean = (cores: Record<string, boolean>) => new Map(Object.entries(cores));

describe('isAutoRecordEligible (auto ยืนยันใน Express)', () => {
  it('transfer + bank-matched + all REs clean → advances', () => {
    expect(isAutoRecordEligible(
      { ...base, reNumbers: ['6908047'], bankMatchCount: 1 },
      clean({ '6908047': true }),
    )).toBe(true);
  });

  it('RE still *** → waits (Express has not received the money yet)', () => {
    expect(isAutoRecordEligible(
      { ...base, reNumbers: ['6908047'], bankMatchCount: 1 },
      clean({ '6908047': false }),
    )).toBe(false);
  });

  it('RE not imported yet → waits (no evidence either way)', () => {
    expect(isAutoRecordEligible(
      { ...base, reNumbers: ['6908047'], bankMatchCount: 1 },
      clean({}),
    )).toBe(false);
  });

  it('multi-RE payment needs EVERY RE clean', () => {
    const p = { ...base, reNumbers: ['6908094', '6908095'], bankMatchCount: 1 };
    expect(isAutoRecordEligible(p, clean({ '6908094': true, '6908095': false }))).toBe(false);
    expect(isAutoRecordEligible(p, clean({ '6908094': true, '6908095': true }))).toBe(true);
  });

  it('transfer without a bank link → waits, even with clean REs', () => {
    expect(isAutoRecordEligible(
      { ...base, reNumbers: ['6908047'], bankMatchCount: 0 },
      clean({ '6908047': true }),
    )).toBe(false);
  });

  it('MB/XS-only payment (no Express side) advances on grounding alone — owner option 1', () => {
    const p = { ...base, billNos: ['9690009'], bankMatchCount: 1 };
    expect(isAutoRecordEligible(p, clean({}))).toBe(true);
    expect(isAutoRecordEligible({ ...p, bankMatchCount: 0 }, clean({}))).toBe(false);
  });

  it('cash/cheque require the CEO ได้รับแล้ว stamp (task-1 gate preserved)', () => {
    const cash = { ...base, source: 'cash', billNos: ['9690009'] };
    expect(isAutoRecordEligible(cash, clean({}))).toBe(false);
    expect(isAutoRecordEligible({ ...cash, receivedAt: new Date() }, clean({}))).toBe(true);
  });

  it('credit-source requires creditUsed (mirrors the credit_required gate)', () => {
    const credit = { ...base, source: 'credit', reNumbers: ['6908050'] };
    expect(isAutoRecordEligible(credit, clean({ '6908050': true }))).toBe(false);
    expect(isAutoRecordEligible({ ...credit, creditUsed: '500.00' }, clean({ '6908050': true }))).toBe(true);
  });

  it('a payment with no documents at all never auto-advances', () => {
    expect(isAutoRecordEligible({ ...base, bankMatchCount: 1 }, clean({}))).toBe(false);
  });
});
