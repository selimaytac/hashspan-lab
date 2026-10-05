import { encodeErrorResult, type Hex, parseAbi } from 'viem';

export const vaultAbi = parseAbi([
  'function withdraw(uint256 amount)',
  'error WithdrawalLimitExceeded(uint256 limit, uint256 requested)',
]);

/** Runtime bytecode that stores `payload` in memory and reverts with it. */
function revertingWith(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  let code = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    code += `7f${word}60${offset.toString(16).padStart(2, '0')}52`;
  }
  return `0x${code}60${size.toString(16).padStart(2, '0')}6000fd`;
}

/** Runtime bytecode of a vault that rejects every withdrawal with `WithdrawalLimitExceeded(limit, requested)`. */
export function vaultCode(limit: bigint, requested: bigint): Hex {
  return revertingWith(
    encodeErrorResult({
      abi: vaultAbi,
      errorName: 'WithdrawalLimitExceeded',
      args: [limit, requested],
    }),
  );
}

/** Creation bytecode that deploys `runtime` (at most 255 bytes) as the contract's code. */
export function deployCode(runtime: Hex): Hex {
  const size = (runtime.length - 2) / 2;
  if (size > 0xff) throw new Error('runtime code too long');
  const length = size.toString(16).padStart(2, '0');
  // PUSH1 size, DUP1, PUSH1 11, PUSH1 0, CODECOPY, PUSH1 0, RETURN: copies the code after these 11 bytes and returns it.
  return `0x60${length}80600b6000396000f3${runtime.slice(2)}`;
}
