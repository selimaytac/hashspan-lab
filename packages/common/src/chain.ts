import { type Address, formatEther, type Hex, type PublicClient } from 'viem';
import { nonceManager, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { LabSetupError } from './errors.js';

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Refuses any chain but `expected`, before anything is read from or sent to it. */
export async function assertChainId(
  client: Pick<PublicClient, 'getChainId'>,
  expected: number,
  label: string,
): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== expected) {
    throw new LabSetupError(
      `The RPC reports chain id ${chainId}; this run only uses ${label} (${expected}).`,
    );
  }
}

export interface WorstCase {
  /** Gas limit of every transaction the run sends. */
  gasLimits: readonly bigint[];
  maxFeePerGas: bigint;
  /** Value the run sends, in wei. */
  value: bigint;
  /**
   * Multiplier on the gas cost, for the L1 data fee and fee changes between the estimate and the send. Default 2.
   */
  margin?: bigint;
}

/** What a run costs at most: viem reserves gas limit times max fee per transaction, times a margin, plus the value. */
export function worstCaseCost({ gasLimits, maxFeePerGas, value, margin = 2n }: WorstCase): bigint {
  const gas = gasLimits.reduce((sum, limit) => sum + limit, 0n);
  return margin * gas * maxFeePerGas + value;
}

/**
 * Checks that `address` holds at least `needed` wei before anything is sent; returns the balance. The message leaves
 * the address out: it goes into the run summary and the ledger, which carry no addresses.
 */
export async function assertBalance(
  client: Pick<PublicClient, 'getBalance'>,
  address: Address,
  needed: bigint,
  label: string,
): Promise<bigint> {
  const balance = await client.getBalance({ address });
  if (balance < needed) {
    throw new LabSetupError(
      `The run needs about ${formatEther(needed)} ETH and the account holds ${formatEther(balance)}; fund it from a ${label} faucet.`,
    );
  }
  return balance;
}

/**
 * The account of `privateKey`, counting its nonces locally: public RPCs balance requests over nodes that can lag a
 * block behind, so a node may not have seen the previous transaction yet.
 */
export function labAccount(privateKey: Hex): PrivateKeyAccount {
  return privateKeyToAccount(privateKey, { nonceManager });
}
