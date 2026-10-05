import { encodeErrorResult, parseAbi } from 'viem';

export { deployCode, revertingWith } from '@hashspan-lab/common';

/** The function the agent calls on every reverting contract, and the custom error one of them reverts with. */
export const revertAbi = parseAbi(['function trigger()', 'error Blocked(uint256 code)']);

export const REVERT_MESSAGE = 'paths: refused';
export const PANIC_CODE = 0x11n;
export const BLOCKED_CODE = 7n;

/** The three kinds of revert data hashspan decodes, with the revert reason it records for each (hashspan ADR 0005). */
export const REVERTS = [
  {
    step: 'revert-string',
    data: encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: [REVERT_MESSAGE],
    }),
    reason: REVERT_MESSAGE,
  },
  {
    step: 'revert-panic',
    data: encodeErrorResult({
      abi: parseAbi(['error Panic(uint256)']),
      errorName: 'Panic',
      args: [PANIC_CODE],
    }),
    reason: `Panic(0x${PANIC_CODE.toString(16)})`,
  },
  {
    step: 'revert-custom',
    data: encodeErrorResult({ abi: revertAbi, errorName: 'Blocked', args: [BLOCKED_CODE] }),
    reason: `Blocked(${BLOCKED_CODE})`,
  },
] as const;
