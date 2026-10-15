import { describe, it, expect } from 'vitest';
import { maasTpmViolations } from '../../../src/routes/api-keys';

describe('maasTpmViolations', () => {
  it('does nothing without an admin maximum', () => {
    expect(maasTpmViolations(null, 0, { m: 0 }, true)).toEqual([]);
  });

  it('rejects a zero global limit and (on update) an explicit null', () => {
    expect(maasTpmViolations(1000, 0, undefined)).toHaveLength(1);
    expect(maasTpmViolations(1000, null, undefined)).toHaveLength(0);
    expect(maasTpmViolations(1000, null, undefined, true)).toHaveLength(1);
    expect(maasTpmViolations(1000, undefined, undefined, true)).toHaveLength(0);
  });

  it('checks every per-model value against the maximum', () => {
    expect(maasTpmViolations(1000, 500, { a: 1000, b: 1 })).toEqual([]);
    expect(maasTpmViolations(1000, 500, { a: 1_000_000_000 })).toHaveLength(1);
    expect(maasTpmViolations(1000, 500, { a: 0 })).toHaveLength(1);
  });
});
