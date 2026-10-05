import { describe, expect, it } from 'vitest';
import { isPrefundError, requiredPrefund, topUpFor } from '../src/prefund.js';

describe('requiredPrefund', () => {
  it('is every gas limit of the operation at its max fee', () => {
    expect(
      requiredPrefund({
        callGasLimit: 100n,
        verificationGasLimit: 200n,
        preVerificationGas: 50n,
        maxFeePerGas: 3n,
      }),
    ).toBe(1050n);
    expect(
      requiredPrefund({
        callGasLimit: 100n,
        verificationGasLimit: 200n,
        preVerificationGas: 50n,
        paymasterVerificationGasLimit: 10n,
        paymasterPostOpGasLimit: 5n,
        maxFeePerGas: 2n,
      }),
    ).toBe(730n);
  });
});

describe('topUpFor', () => {
  it('sends nothing when the account holds the prefund, else enough to hold twice it', () => {
    expect(topUpFor(1050n, 1050n)).toBe(0n);
    expect(topUpFor(2000n, 1050n)).toBe(0n);
    expect(topUpFor(400n, 1050n)).toBe(1700n);
    expect(topUpFor(0n, 1050n)).toBe(2100n);
  });
});

describe('isPrefundError', () => {
  it('recognizes AA21 and insufficient funds anywhere in the cause chain', () => {
    expect(isPrefundError(new Error("AA21 didn't pay prefund"))).toBe(true);
    const wrapped = new Error('UserOperation execution failed', {
      cause: new Error(
        'Smart Account does not have sufficient funds to execute the User Operation.',
      ),
    });
    expect(isPrefundError(wrapped)).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(isPrefundError(new Error('AA10 sender already constructed'))).toBe(false);
    expect(isPrefundError('AA21')).toBe(false);
  });
});
