import { describe, expect, it } from 'vitest';
import { deployCode, REVERTS, revertingWith } from '../src/contracts.js';

describe('reverting contracts', () => {
  it('fit in the 255 bytes the creation code copies', () => {
    for (const { data } of REVERTS) expect(() => deployCode(revertingWith(data))).not.toThrow();
  });

  it('expect the reason format hashspan records for each kind of revert data', () => {
    expect(REVERTS.map(({ reason }) => reason)).toEqual([
      'paths: refused',
      'Panic(0x11)',
      'Blocked(7)',
    ]);
  });
});
