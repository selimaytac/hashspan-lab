import type { SpanExpectation } from '@hashspan-lab/common';

export const AGENT_NAME = 'user-operations-agent';
export const ROOT_SPAN = 'user-operations run';
export const STEP = 'step user-operation';

export interface ExpectationOptions {
  chainId: number;
  /** The smart account, lower-case, as hashspan records it. */
  sender: string;
}

/**
 * What one run must leave behind, against the @hashspan/viem README section "Smart accounts (ERC-4337)" and hashspan
 * ADR 0021: the user operation has a send span under its step with its hash, the smart account, the EntryPoint and
 * two calls, and no transaction attributes; its confirm span, from the receipt the wait returned, has `success`, the
 * EntryPoint, nonce, gas used and cost, and the bundle transaction. Neither the EntryPoint address nor its version is
 * pinned: live and local runs use different ones.
 */
export function userOperationExpectations({
  chainId,
  sender,
}: ExpectationOptions): SpanExpectation[] {
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    {
      name: `send ${chainId}`,
      count: 1,
      parent: STEP,
      sameTrace: true,
      attributes: {
        'blockchain.user_operation.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.user_operation.sender': sender,
        'blockchain.user_operation.entry_point': /^0x[0-9a-f]{40}$/,
        'blockchain.user_operation.call_count': 2,
        'gen_ai.agent.name': AGENT_NAME,
      },
    },
    {
      name: `confirm ${chainId}`,
      count: 1,
      where: { 'blockchain.user_operation.success': true },
      parent: STEP,
      sameTrace: true,
      attributes: {
        'blockchain.user_operation.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.user_operation.entry_point': /^0x[0-9a-f]{40}$/,
        'blockchain.user_operation.nonce': /^\d+$/,
        'blockchain.user_operation.gas.used': { present: true },
        'blockchain.user_operation.gas.cost': /^\d+$/,
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.block.number': { present: true },
      },
    },
  ];
}
