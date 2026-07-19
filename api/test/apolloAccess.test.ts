import { describe, expect, it } from 'vitest';
import { isApolloManager } from '../src/apollo/access.js';

describe('Apollo manager role gate', () => {
  it('admits only supervisor and gm', () => {
    expect(isApolloManager('supervisor')).toBe(true);
    expect(isApolloManager('gm')).toBe(true);
    expect(isApolloManager('central')).toBe(false);
    expect(isApolloManager('employee')).toBe(false);
  });
});
