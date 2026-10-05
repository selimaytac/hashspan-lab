import type { SpanExpectation } from '@hashspan-lab/common';
import { entryPoint07Address } from 'viem/account-abstraction';

export const AGENT_NAME = 'user-operations-v07-agent';
export const ROOT_SPAN = 'user-operations-v07 run';
/** One step span per bundler, named after it. */
export const stepName = (bundler: string): string => `step user-operation ${bundler}`;

/** One sent operation: the bundler's name and the hash it returned. */
export interface SentOperation {
  bundler: string;
  userOpHash: string;
}

export interface ExpectationOptions {
  chainId: number;
  /** The smart account, lower-case, as hashspan records it. */
  sender: string;
  operations: readonly SentOperation[];
}

/**
 * What one run must leave behind, against the @hashspan/viem README section "Smart accounts (ERC-4337)" and hashspan
 * ADR 0021, for each operation under its own step: a send span with its hash, the smart account, EntryPoint v0.7 and
 * two calls; a confirm span, from the receipt the wait returned, with `success`, the smart account, EntryPoint v0.7,
 * nonce, gas used and cost, and the bundle transaction. Unlike `scenarios/user-operations`, the EntryPoint is pinned:
 * live and local runs both use v0.7's canonical address. hashspan records no EntryPoint version (ADR 0021 settled on
 * the address), so the address is what tells v0.7 apart.
 */
export function userOperationExpectations({
  chainId,
  sender,
  operations,
}: ExpectationOptions): SpanExpectation[] {
  const entryPoint = entryPoint07Address.toLowerCase();
  return [
    { name: ROOT_SPAN, count: 1, sameTrace: true },
    { name: `send ${chainId}`, count: operations.length, sameTrace: true },
    { name: `confirm ${chainId}`, count: operations.length, sameTrace: true },
    ...operations.flatMap(({ bundler, userOpHash }): SpanExpectation[] => [
      {
        name: stepName(bundler),
        count: 1,
        parent: ROOT_SPAN,
        sameTrace: true,
      },
      {
        name: `send ${chainId}`,
        count: 1,
        where: { 'blockchain.user_operation.hash': userOpHash },
        parent: stepName(bundler),
        attributes: {
          'blockchain.user_operation.sender': sender,
          'blockchain.user_operation.entry_point': entryPoint,
          'blockchain.user_operation.call_count': 2,
          'gen_ai.agent.name': AGENT_NAME,
        },
      },
      {
        name: `confirm ${chainId}`,
        count: 1,
        where: {
          'blockchain.user_operation.hash': userOpHash,
          'blockchain.user_operation.success': true,
        },
        parent: stepName(bundler),
        attributes: {
          'blockchain.user_operation.sender': sender,
          'blockchain.user_operation.entry_point': entryPoint,
          'blockchain.user_operation.nonce': /^\d+$/,
          'blockchain.user_operation.gas.used': { present: true },
          'blockchain.user_operation.gas.cost': /^\d+$/,
          'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
          'blockchain.block.number': { present: true },
        },
      },
    ]),
  ];
}
