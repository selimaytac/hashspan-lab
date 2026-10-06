import type { SpanExpectation } from '@hashspan-lab/common';
import { REVERTS } from './contracts.js';

export const AGENT_NAME = 'paths-agent';
export const BAGGAGE_AGENT_ID = 'paths-agent-from-baggage';
export const ROOT_SPAN = 'paths run';

export interface ExpectationOptions {
  chainId: number;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
}

/**
 * What one run must leave behind, each against the @hashspan/viem README section it checks:
 * - "Background confirmation": a send without a wait still gets a confirm span, under the step it was sent in.
 * - "Transactions sent elsewhere": `watch()` records a confirm span for a hash sent by an untraced client, and no
 *   send span exists for it.
 * - "JSON-RPC requests": `traceTransport()` records `eth_sendRawTransaction` under each send span.
 * - "Revert reasons": `Error(string)`, `Panic` and a custom error with arguments are decoded.
 */
export function pathsExpectations({ chainId, opStack }: ExpectationOptions): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  const receipt = {
    'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
    'blockchain.block.number': { present: true },
    'blockchain.tx.gas.used': { present: true },
    'blockchain.tx.fee': /^\d+$/,
    'gen_ai.agent.name': AGENT_NAME,
    'gen_ai.agent.id': BAGGAGE_AGENT_ID,
    ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
  } as const;
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    // Background confirmation, the three reverting calls; the watched transaction has no send span.
    {
      name: send,
      count: 4,
      parent: /^step /,
      sameTrace: true,
      // The static identity has no id: Baggage fills it (ADR 0011).
      attributes: { 'gen_ai.agent.name': AGENT_NAME, 'gen_ai.agent.id': BAGGAGE_AGENT_ID },
    },
    // The background confirmation and the watched transaction: each under the step it ran in (checked per step by
    // the ledger entry's `tool`; `parent` here only says the span is under one of the two).
    {
      name: confirm,
      count: 2,
      where: { 'blockchain.tx.status': 'success' },
      parent: /^step (background|watch)$/,
      sameTrace: true,
      attributes: receipt,
    },
    ...REVERTS.map(
      ({ step, reason }): SpanExpectation => ({
        name: confirm,
        count: 1,
        where: { 'blockchain.tx.revert.reason': reason },
        parent: `step ${step}`,
        sameTrace: true,
        attributes: { ...receipt, 'blockchain.tx.status': 'reverted', 'error.type': 'reverted' },
      }),
    ),
    {
      name: 'eth_sendRawTransaction',
      count: 4,
      parent: send,
      attributes: { 'rpc.system.name': 'jsonrpc', 'rpc.method': 'eth_sendRawTransaction' },
    },
  ];
}
