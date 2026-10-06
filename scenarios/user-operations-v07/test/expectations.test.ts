import { describe, expect, it } from 'vitest';
import { ROOT_SPAN, stepName, userOperationExpectations } from '../src/expectations.js';

describe('userOperationExpectations', () => {
  const operations = [
    { bundler: 'pimlico', userOpHash: `0x${'1'.repeat(64)}` },
    { bundler: 'candide', userOpHash: `0x${'2'.repeat(64)}` },
  ];
  const expectations = userOperationExpectations({ chainId: 84532, sender: '0xabc', operations });

  it('counts one send and one confirm span per operation', () => {
    expect(expectations).toContainEqual({ name: 'send 84532', count: 2, sameTrace: true });
    expect(expectations).toContainEqual({ name: 'confirm 84532', count: 2, sameTrace: true });
  });

  it("checks each operation's spans under its own step, with EntryPoint v0.7 pinned", () => {
    for (const { bundler, userOpHash } of operations) {
      expect(expectations).toContainEqual(
        expect.objectContaining({ name: stepName(bundler), parent: ROOT_SPAN }),
      );
      for (const name of ['send 84532', 'confirm 84532']) {
        const expectation = expectations.find(
          (entry) =>
            entry.name === name && entry.where?.['blockchain.user_operation.hash'] === userOpHash,
        );
        expect(expectation?.parent).toBe(stepName(bundler));
        expect(expectation?.attributes?.['blockchain.user_operation.entry_point']).toBe(
          '0x0000000071727de22e5e9d8baf0edac6f37da032',
        );
        expect(expectation?.attributes?.['blockchain.user_operation.sender']).toBe('0xabc');
      }
    }
  });

  it('expects the paymaster on a sponsored operation and no paymaster on any other', () => {
    const sponsor = '0x000000000000000000000000000000000000a1ce';
    const mixed = userOperationExpectations({
      chainId: 84532,
      sender: '0xabc',
      operations: [
        { bundler: 'pimlico', userOpHash: `0x${'1'.repeat(64)}` },
        { bundler: 'sponsored', userOpHash: `0x${'3'.repeat(64)}`, paymaster: sponsor },
      ],
    });
    const confirmOf = (hash: string) =>
      mixed.find(
        (entry) =>
          entry.name === 'confirm 84532' &&
          entry.where?.['blockchain.user_operation.hash'] === hash,
      );
    expect(
      confirmOf(`0x${'3'.repeat(64)}`)?.attributes?.['blockchain.user_operation.paymaster'],
    ).toBe(sponsor);
    expect(
      confirmOf(`0x${'1'.repeat(64)}`)?.attributes?.['blockchain.user_operation.paymaster'],
    ).toEqual({
      absent: true,
    });
  });
});
