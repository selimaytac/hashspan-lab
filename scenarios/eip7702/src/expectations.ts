import type { SpanExpectation } from '@hashspan-lab/common';
import { zeroAddress } from 'viem';

export const AGENT_NAME = 'eip7702-agent';
export const ROOT_SPAN = 'eip7702 run';

export interface ExpectationOptions {
  chainId: number;
  /** The contract the first authorization delegates to, as hashspan records it (lower case). */
  delegate: string;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
}

/**
 * What one run must leave behind, against the `blockchain.tx.authorization.*` rows of hashspan's semconv: a send span
 * per type 4 transaction with its one authorization's delegated address and chain id (the zero address for the one
 * that clears the delegation), under the step it was sent in, and a successful confirm span for each.
 */
export function eip7702Expectations({
  chainId,
  delegate,
  opStack,
}: ExpectationOptions): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  const authorization = (address: string) => ({
    'blockchain.tx.authorization.count': 1,
    'blockchain.tx.authorization.addresses': [address],
    'blockchain.tx.authorization.chain_ids': [chainId],
    'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
    'gen_ai.agent.name': AGENT_NAME,
  });
  return [
    { name: send, count: 2, sameTrace: true },
    {
      name: send,
      count: 1,
      where: { 'blockchain.tx.authorization.addresses': [delegate] },
      parent: 'step delegate',
      attributes: authorization(delegate),
    },
    {
      name: send,
      count: 1,
      where: { 'blockchain.tx.authorization.addresses': [zeroAddress] },
      parent: 'step clear',
      attributes: authorization(zeroAddress),
    },
    {
      name: confirm,
      count: 2,
      where: { 'blockchain.tx.status': 'success' },
      parent: /^step (delegate|clear)$/,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.tx.gas.used': { present: true },
        'blockchain.tx.fee': /^\d+$/,
        ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
      },
    },
  ];
}
