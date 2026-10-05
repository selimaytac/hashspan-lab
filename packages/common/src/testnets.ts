import type { Chain } from 'viem';
import { arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from 'viem/chains';
import { BASE_SEPOLIA_ENV, readTestnetEnv, type TestnetEnv, type TestnetEnvNames } from './env.js';
import { LabSetupError } from './errors.js';

/** A public testnet the lab runs on. */
export interface Testnet {
  /** Name in `LAB_TESTNET` and in workflow inputs. */
  id: string;
  label: string;
  chain: Chain;
  env: TestnetEnvNames;
  explorer: string;
  /** Whether receipts carry an L1 data fee (OP-stack chains), so confirm spans have `blockchain.tx.l1_fee`. */
  opStack: boolean;
  /**
   * Below this balance (wei) the balance check reports the lab account. Measured on 2026-10-04 (treasury, vault
   * deployment included): Ethereum Sepolia about 0.000125 ETH a run, Arbitrum Sepolia 0.0000076, OP Sepolia 0.0000002;
   * Base Sepolia runs the whole daily matrix. Each threshold leaves about four days of runs.
   */
  lowBalanceWei: bigint;
  /**
   * What one treasury run costs (wei), vault deployment included, shown by `pnpm lab testnet` before anything is
   * sent. `measured` is false when it is an estimate.
   */
  runCostWei: bigint;
  measured: boolean;
}

// Base Sepolia's runCostWei is an estimate (an OP-stack chain like OP Sepolia, rounded up five times); the others
// were measured on 2026-10-04, see lowBalanceWei.
// One lab account for every testnet: a chain's own key variable wins, else the Base Sepolia key is used, so funding
// the same address on each chain is enough. Public RPCs that answered eth_chainId on 2026-10-04.
const lab = (prefix: string, defaultRpcUrl: string): TestnetEnvNames => ({
  key: `${prefix}_PRIVATE_KEY`,
  fallbackKey: BASE_SEPOLIA_ENV.key,
  rpcUrl: `${prefix}_RPC_URL`,
  defaultRpcUrl,
});

export const TESTNETS: readonly Testnet[] = [
  {
    id: 'base-sepolia',
    label: 'Base Sepolia',
    chain: baseSepolia,
    env: BASE_SEPOLIA_ENV,
    explorer: 'https://sepolia.basescan.org',
    opStack: true,
    lowBalanceWei: 500_000_000_000_000n,
    runCostWei: 1_000_000_000_000n,
    measured: false,
  },
  {
    id: 'sepolia',
    label: 'Ethereum Sepolia',
    chain: sepolia,
    env: lab('SEPOLIA', 'https://ethereum-sepolia-rpc.publicnode.com'),
    explorer: 'https://sepolia.etherscan.io',
    opStack: false,
    lowBalanceWei: 500_000_000_000_000n,
    runCostWei: 125_000_000_000_000n,
    measured: true,
  },
  {
    id: 'arbitrum-sepolia',
    label: 'Arbitrum Sepolia',
    chain: arbitrumSepolia,
    env: lab('ARBITRUM_SEPOLIA', 'https://sepolia-rollup.arbitrum.io/rpc'),
    explorer: 'https://sepolia.arbiscan.io',
    opStack: false,
    lowBalanceWei: 50_000_000_000_000n,
    runCostWei: 7_600_000_000_000n,
    measured: true,
  },
  {
    id: 'op-sepolia',
    label: 'OP Sepolia',
    chain: optimismSepolia,
    env: lab('OP_SEPOLIA', 'https://sepolia.optimism.io'),
    explorer: 'https://sepolia-optimism.etherscan.io',
    opStack: true,
    lowBalanceWei: 10_000_000_000_000n,
    runCostWei: 200_000_000_000n,
    measured: true,
  },
];

/** The testnet named by `id` (`base-sepolia` when unset or empty). */
export function testnet(id: string | undefined): Testnet {
  const name = id || 'base-sepolia';
  const found = TESTNETS.find((entry) => entry.id === name);
  if (!found) {
    throw new LabSetupError(
      `Unknown testnet ${JSON.stringify(name)}; expected one of ${TESTNETS.map((entry) => entry.id).join(', ')}.`,
    );
  }
  return found;
}

/** The key and RPC URL of `net` from the environment, without ever echoing them back. */
export function readLabTestnetEnv(
  env: Record<string, string | undefined>,
  net: Testnet,
): TestnetEnv {
  return readTestnetEnv(env, net.env);
}
