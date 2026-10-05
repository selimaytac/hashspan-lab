import type { SpanExpectation } from '@hashspan-lab/common';

export const AGENT_NAME = 'x402-agent';
export const ROOT_SPAN = 'x402 run';
export const PAY_STEP = 'step pay';

export interface ExpectationOptions {
  chainId: number;
  /** Lower-case addresses, as hashspan records them. */
  payer: string;
  recipient: string;
  asset: string;
  amount: bigint;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
}

/**
 * What one run must leave behind, against the @hashspan/x402 README, hashspan ADR 0013 and ADR 0017:
 * - the payment is a `payment` span under the step that paid, settled, with payer, recipient, asset and amount;
 * - the settling transaction's logs carry this payment (`blockchain.payment.verified`);
 * - the facilitator's transaction gets a `confirm` span under the same step, with its receipt and fees. Its link to the payment span is checked in
 *   `run.ts`, since links are not part of these expectations.
 */
export function paymentExpectations({
  chainId,
  payer,
  recipient,
  asset,
  amount,
  opStack,
}: ExpectationOptions): SpanExpectation[] {
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    {
      name: `payment ${chainId}`,
      count: 1,
      parent: PAY_STEP,
      sameTrace: true,
      attributes: {
        'blockchain.payment.status': 'settled',
        'blockchain.payment.verified': true,
        'blockchain.payment.payer': payer,
        'blockchain.payment.recipient': recipient,
        'blockchain.payment.asset': asset,
        'blockchain.payment.amount': String(amount),
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'x402.scheme': 'exact',
        'x402.resource': 'http://paid-api.lab',
      },
    },
    {
      name: `confirm ${chainId}`,
      count: 1,
      where: { 'blockchain.tx.status': 'success' },
      parent: PAY_STEP,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.block.number': { present: true },
        'blockchain.tx.fee': /^\d+$/,
        ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
      },
    },
  ];
}
