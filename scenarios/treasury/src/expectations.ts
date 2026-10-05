import type { SpanExpectation } from '@hashspan-lab/common';
import { parseEther } from 'viem';
import { AGENT_NAME, WITHDRAW_ETH, WITHDRAW_LIMIT_ETH } from './chain.js';

export interface ExpectationOptions {
  chainId: number;
  /** Whether the chain is an OP-stack chain, whose receipts carry an L1 data fee (Base Sepolia is; Anvil is not). */
  opStack: boolean;
}

/**
 * What one run must leave behind: a send and a confirm span per tool call, under that tool's span and in one trace,
 * with the agent's name, the receipt's data and the decoded revert reason of the rejected withdrawal.
 */
export function treasuryExpectations({ chainId, opStack }: ExpectationOptions): SpanExpectation[] {
  const send = `send ${chainId}`;
  const confirm = `confirm ${chainId}`;
  const receipt = {
    'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
    'blockchain.block.number': { present: true },
    'blockchain.tx.gas.used': { present: true },
    'blockchain.tx.effective_gas_price': /^\d+$/,
    'blockchain.tx.fee': /^\d+$/,
    'gen_ai.agent.name': AGENT_NAME,
    ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
  } as const;
  return [
    { name: 'execute_tool pay_vendor', count: 1, sameTrace: true },
    { name: 'execute_tool withdraw_from_vault', count: 1, sameTrace: true },
    {
      name: send,
      count: 2,
      parent: /^execute_tool /,
      sameTrace: true,
      attributes: {
        'blockchain.system.name': 'evm',
        // Removed in hashspan 1.0 (ADR 0027): must not come back.
        'blockchain.system': { absent: true },
        'blockchain.chain.id': chainId,
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        // Not blockchain.tx.nonce: @hashspan/viem records it only when the call passes one (hashspan #159), and with
        // viem's nonceManager the call does not.
        'gen_ai.agent.name': AGENT_NAME,
      },
    },
    {
      name: send,
      count: 1,
      where: { 'blockchain.contract.function.name': 'withdraw' },
      parent: 'execute_tool withdraw_from_vault',
      attributes: {
        'blockchain.contract.function.arguments': `["${parseEther(WITHDRAW_ETH)}"]`,
      },
    },
    {
      name: confirm,
      count: 1,
      where: { 'blockchain.tx.status': 'success' },
      parent: 'execute_tool pay_vendor',
      sameTrace: true,
      attributes: receipt,
    },
    {
      name: confirm,
      count: 1,
      where: { 'blockchain.tx.status': 'reverted' },
      parent: 'execute_tool withdraw_from_vault',
      sameTrace: true,
      attributes: {
        ...receipt,
        'error.type': 'reverted',
        'blockchain.tx.revert.reason': `WithdrawalLimitExceeded(${parseEther(WITHDRAW_LIMIT_ETH)}, ${parseEther(WITHDRAW_ETH)})`,
      },
    },
  ];
}
