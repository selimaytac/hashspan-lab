/** The gas fields of a prepared EntryPoint v0.7 user operation that bound what the account must hold. */
export interface PreparedGas {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint | undefined;
  paymasterPostOpGasLimit?: bigint | undefined;
  maxFeePerGas: bigint;
}

/**
 * What the EntryPoint requires the account to hold before it runs an operation without a paymaster: every gas limit
 * of the operation at its max fee (EntryPoint v0.7 `_getRequiredPrefund`). A bundler simulates exactly this.
 */
export function requiredPrefund(gas: PreparedGas): bigint {
  const limits =
    gas.callGasLimit +
    gas.verificationGasLimit +
    gas.preVerificationGas +
    (gas.paymasterVerificationGasLimit ?? 0n) +
    (gas.paymasterPostOpGasLimit ?? 0n);
  return limits * gas.maxFeePerGas;
}

/**
 * How much to send the account before an operation: nothing when it already holds the required prefund, else enough
 * to hold twice it, since the bundler's estimate may rise between this check and the send.
 */
export function topUpFor(held: bigint, required: bigint): bigint {
  return held >= required ? 0n : 2n * required - held;
}

/**
 * Whether a bundler refused to simulate an operation because the account holds too little for its prefund: AA21
 * ("didn't pay prefund") or a message about insufficient funds, anywhere in the error's cause chain.
 */
export function isPrefundError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    const text = `${current.message} ${(current as { details?: unknown }).details ?? ''}`;
    if (/AA21|didn't pay prefund|sufficient funds/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
