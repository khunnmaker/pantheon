// Unit test for the Party identity normaliser (api/src/scripts/backfillParties.ts).
// Pure over strings, no DB — importing the module must NOT run the backfill (guarded by
// the isMain check in the script).
import { describe, it, expect } from 'vitest';
import { normalize } from '../src/scripts/backfillParties.js';

describe('normalize express_code', () => {
  it('lowercases and strips dashes (venus toSearchKey parity)', () => {
    expect(normalize('express_code', 'C-ก-002')).toBe('cก002');
    expect(normalize('express_code', 'cก002')).toBe('cก002');
    expect(normalize('express_code', 'Cก002')).toBe('cก002');
  });

  it('folds Thai digits ๐-๙ → 0-9 so ๙๙0000006 == 990000006', () => {
    expect(normalize('express_code', '๙๙0000006')).toBe('990000006');
    expect(normalize('express_code', '990000006')).toBe('990000006');
    expect(normalize('express_code', 'ร๑๐๓')).toBe('ร103');
  });

  it('strips surrounding whitespace and punctuation', () => {
    expect(normalize('express_code', '  A001  ')).toBe('a001');
    expect(normalize('express_code', 'A 001')).toBe('a001');
  });
});

describe('normalize email channels', () => {
  it('lowercases + trims diana_email and agent_email', () => {
    expect(normalize('diana_email', '  Clinic@Example.COM ')).toBe('clinic@example.com');
    expect(normalize('agent_email', 'M-Ta@Prominent.Local')).toBe('m-ta@prominent.local');
  });
});

describe('normalize phone', () => {
  it('keeps digits only', () => {
    expect(normalize('phone', '081-234-5678')).toBe('0812345678');
    expect(normalize('phone', '+66 (81) 234 5678')).toBe('66812345678');
  });
});

describe('normalize passthrough + empties', () => {
  it('trims but otherwise passes through unknown/opaque channels', () => {
    expect(normalize('line_user', '  U1234abcd  ')).toBe('U1234abcd');
    expect(normalize('oa_chat', 'Uffff0000')).toBe('Uffff0000');
    expect(normalize('ceres_name', ' ต้า ')).toBe('ต้า');
  });

  it('returns "" for empty / null / whitespace-only (never links an empty key)', () => {
    expect(normalize('express_code', '')).toBe('');
    expect(normalize('express_code', null)).toBe('');
    expect(normalize('express_code', undefined)).toBe('');
    expect(normalize('phone', '   ')).toBe('');
    expect(normalize('express_code', '---')).toBe('');
    expect(normalize('diana_email', '  ')).toBe('');
  });
});
