import { checkSpans } from '@hashspan-lab/common';
import { describe, expect, it } from 'vitest';
import { eip7702Expectations } from '../src/expectations.js';

describe('eip7702Expectations', () => {
  it('expects two sends, one per step, and two successful confirms', () => {
    const expectations = eip7702Expectations({ chainId: 84532, delegate: '0xabc', opStack: true });
    expect(expectations.map((e) => [e.name, e.count, e.parent?.toString()])).toEqual([
      ['send 84532', 2, undefined],
      ['send 84532', 1, 'step delegate'],
      ['send 84532', 1, 'step clear'],
      ['confirm 84532', 2, '/^step (delegate|clear)$/'],
    ]);
    expect(expectations[2]?.attributes?.['blockchain.tx.authorization.addresses']).toEqual([
      '0x0000000000000000000000000000000000000000',
    ]);
    expect(checkSpans([], expectations).length).toBeGreaterThan(0);
  });
});
