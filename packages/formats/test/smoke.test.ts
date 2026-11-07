import { describe, it, expect } from 'vitest';
import { readFixture, describeFx } from './fixtures';

describeFx('fixtures', () => {
  it('are present', () => {
    expect(readFixture('Lab3', 'Lab3.mcp').subarray(0, 4).toString('latin1')).toBe('looc');
  });
});
