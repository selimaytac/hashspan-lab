import type { SpanExpectation } from '@hashspan-lab/common';

export const AGENT_NAME = 'call-batches-agent';
export const ROOT_SPAN = 'call-batches run';

export interface ExpectationOptions {
  chainId: number;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
}

/**
 * What one run must leave behind, against the @hashspan/viem README section "Call batches (EIP-5792)" and hashspan
 * ADR 0022:
 * - each batch has a send span with its id and number of calls;
 * - a batch of two transfers ends with `blockchain.call_batch.status` `success` and both transaction hashes;
 * - a batch whose second call fails to send ends as `partially_reverted` (viem's status 600 with fewer receipts);
 * - the transactions viem sent are confirmed as transactions, with their fees, whether or not anyone waits for them.
 */
export function batchExpectations({ chainId, opStack }: ExpectationOptions): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    {
      name: send,
      count: 2,
      where: { 'blockchain.call_batch.call_count': 2 },
      parent: /^step /,
      sameTrace: true,
      attributes: {
        'blockchain.call_batch.id': /^0x[0-9a-f]+$/,
        'gen_ai.agent.name': AGENT_NAME,
      },
    },
    {
      name: confirm,
      count: 1,
      where: { 'blockchain.call_batch.status': 'success' },
      parent: 'step transfers',
      sameTrace: true,
      attributes: {
        'blockchain.call_batch.status_code': 200,
        'blockchain.call_batch.atomic': false,
        'blockchain.call_batch.transaction_hashes': { present: true },
        'blockchain.block.number': { present: true },
      },
    },
    {
      name: confirm,
      count: 1,
      where: { 'blockchain.call_batch.status': 'partially_reverted' },
      parent: 'step failed-call',
      sameTrace: true,
      attributes: { 'blockchain.call_batch.status_code': 600, 'error.type': 'partially_reverted' },
    },
    {
      // The three plain transactions of viem's fallback: two transfers, then the first call of the second batch.
      name: confirm,
      count: 3,
      where: { 'blockchain.tx.status': 'success' },
      parent: /^step /,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.tx.fee': /^\d+$/,
        ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
      },
    },
  ];
}
