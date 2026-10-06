import type { SpanExpectation } from '@hashspan-lab/common';

export const AGENT_NAME = 'replacement-agent';
export const AGENT_ID = 'replacement-agent-1';
export const ROOT_SPAN = 'replacement run';

/** The three ways viem tells a replacement apart, each as a step of the run. */
export const STEPS = [
  { name: 'repriced', reason: 'repriced' },
  { name: 'cancelled', reason: 'cancelled' },
  { name: 'replaced', reason: 'replaced' },
] as const;

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * What one run must leave behind, against hashspan's documented rules for replaced transactions (semconv "Replaced
 * transactions", ADR 0008): the confirm span of the awaited hash ends as `replaced` with the hash and the reason of the
 * replacement and without block, gas or fee, and the mined replacement has a confirm span of its own, under the same
 * step, with its receipt. Links and start times are checked by `replacementLinkFindings`.
 */
export function replacementExpectations({ chainId }: { chainId: number }): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    // The original and the replacement of each step both go through the traced wallet.
    {
      name: send,
      count: STEPS.length * 2,
      parent: /^step /,
      sameTrace: true,
      // The static identity wins over a Baggage that says otherwise (ADR 0011).
      attributes: { 'gen_ai.agent.name': AGENT_NAME, 'gen_ai.agent.id': AGENT_ID },
    },
    ...STEPS.map(
      ({ name, reason }): SpanExpectation => ({
        name: confirm,
        count: 1,
        where: { 'blockchain.tx.replacement.reason': reason },
        parent: `step ${name}`,
        sameTrace: true,
        attributes: {
          'blockchain.tx.status': 'replaced',
          'blockchain.tx.hash': HASH,
          'blockchain.tx.replacement.hash': HASH,
          'gen_ai.agent.name': AGENT_NAME,
          'gen_ai.agent.id': AGENT_ID,
          // A replaced transaction has no receipt of its own.
          'blockchain.block.number': { absent: true },
          'blockchain.tx.gas.used': { absent: true },
          'blockchain.tx.fee': { absent: true },
          'error.type': { absent: true },
        },
      }),
    ),
    {
      name: confirm,
      count: STEPS.length,
      where: { 'blockchain.tx.status': 'success' },
      parent: /^step /,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': HASH,
        'blockchain.block.number': { present: true },
        'blockchain.tx.gas.used': { present: true },
        'blockchain.tx.fee': /^\d+$/,
        'gen_ai.agent.name': AGENT_NAME,
        'gen_ai.agent.id': AGENT_ID,
      },
    },
  ];
}
