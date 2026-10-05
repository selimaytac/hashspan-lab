import type { SpanExpectation } from '@hashspan-lab/common';

export const AGENT_NAME = 'cdp-agent';
export const ROOT_SPAN = 'cdp run';

export interface ExpectationOptions {
  chainId: number;
  /** The CDP account, lower-case, as hashspan records it. */
  from: string;
  /** The CDP smart account, lower-case. */
  smartAccount: string;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
}

/**
 * What one run must leave behind, against the @hashspan/cdp README: each step's transaction (the account's own
 * `sendTransaction`, then the network-scoped account's, confirmed through CDP's node with its own wait) has a send
 * span under its step, with sender, recipient and value, and a confirm span with the receipt and fees. The smart
 * account's user operation (hashspan ADR 0021) has a send span with its hash, sender and number of calls, and a
 * confirm span from its `UserOperationEvent`: success, entry point, nonce, gas cost and the bundle transaction.
 */
export function cdpExpectations({
  chainId,
  from,
  smartAccount,
  opStack,
}: ExpectationOptions): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  const sent = (value: string, step: string): SpanExpectation => ({
    name: send,
    count: 1,
    where: { 'blockchain.tx.value': value },
    parent: step,
    sameTrace: true,
    attributes: {
      'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
      'blockchain.tx.from': from,
      'blockchain.tx.to': from,
      'gen_ai.agent.name': AGENT_NAME,
    },
  });
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    sent('1', 'step account'),
    sent('2', 'step scoped'),
    {
      name: confirm,
      count: 2,
      where: { 'blockchain.tx.status': 'success' },
      parent: /^step /,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.block.number': { present: true },
        'blockchain.tx.gas.used': 21_000,
        'blockchain.tx.fee': /^\d+$/,
        ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
      },
    },
    {
      name: send,
      count: 1,
      where: { 'blockchain.user_operation.call_count': 2 },
      parent: 'step smart',
      sameTrace: true,
      attributes: {
        'blockchain.user_operation.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.user_operation.sender': smartAccount,
        'gen_ai.agent.name': AGENT_NAME,
      },
    },
    {
      name: confirm,
      count: 1,
      where: { 'blockchain.user_operation.success': true },
      parent: 'step smart',
      sameTrace: true,
      attributes: {
        'blockchain.user_operation.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.user_operation.entry_point': /^0x[0-9a-f]{40}$/,
        'blockchain.user_operation.nonce': /^\d+$/,
        'blockchain.user_operation.gas.cost': /^\d+$/,
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
      },
    },
  ];
}
