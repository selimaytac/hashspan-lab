import { withHashspan } from '@hashspan/viem';
import {
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_ENV,
  type ErrorKind,
  errorKind,
  type Finding,
  LabSetupError,
  type LabTelemetry,
  safeErrorMessage,
} from '@hashspan-lab/common';
import { createPublicClient, type Hash, http, numberToHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { compareFees, type SealedReceipt } from './compare.js';

export const SCENARIO = 'sealed-fees';
export const AGENT_NAME = 'sealed-fees-watcher';

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Most transactions to watch. */
  sampleSize?: number;
  /** How long to collect transactions from the pending block, in ms. */
  sampleMs?: number;
  /** Fewer checked transactions than this is a setup error (an idle chain or a failing RPC), not a finding. */
  minChecked?: number;
  /** Receipt polling interval in ms. */
  pollingInterval?: number;
}

/** One line of the run ledger: constants and counts only, never an address, a key or an RPC URL. */
export interface SealedFeesSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  watched: number;
  checked: number;
  withoutFees: number;
  exportErrors: string[];
}

/** The RPC URL from `BASE_SEPOLIA_RPC_URL`, else the public endpoint; no key is needed to watch. */
export function readRpcUrl(env: Record<string, string | undefined>): string {
  const rpcUrl = env[BASE_SEPOLIA_ENV.rpcUrl] || BASE_SEPOLIA_ENV.defaultRpcUrl;
  let protocol: string;
  try {
    protocol = new URL(rpcUrl).protocol;
  } catch {
    throw new LabSetupError(`${BASE_SEPOLIA_ENV.rpcUrl} is not a valid URL.`);
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new LabSetupError(`${BASE_SEPOLIA_ENV.rpcUrl} must be an http or https URL.`);
  }
  return rpcUrl;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const watcher = (rpcUrl: string, pollingInterval: number) =>
  createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), pollingInterval });

/**
 * Watches transactions of other accounts from Base Sepolia's pending block with `watch()`, ends the telemetry, and
 * compares each confirm span with the sealed receipts of its block. Sends nothing and needs no key. Never throws.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  {
    env,
    log,
    sampleSize = 50,
    sampleMs = 30_000,
    minChecked = 10,
    pollingInterval = 500,
  }: ScenarioOptions,
): Promise<SealedFeesSummary> {
  const startedAt = new Date();
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  const watched = new Set<Hash>();
  let client: ReturnType<typeof watcher> | undefined;
  try {
    const reader = watcher(readRpcUrl(env), pollingInterval);
    client = reader;
    await assertChainId(reader, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    const deadline = Date.now() + sampleMs;
    while (Date.now() < deadline && watched.size < sampleSize) {
      const pending = await reader.request({
        method: 'eth_getBlockByNumber',
        params: ['pending', false],
      });
      for (const hash of (pending?.transactions ?? []) as Hash[]) {
        if (watched.size >= sampleSize || watched.has(hash)) continue;
        watched.add(hash);
        hashspan.watch(reader, { hash, chainId: BASE_SEPOLIA_CHAIN_ID });
      }
      await sleep(pollingInterval);
    }
    log(`Watching ${watched.size} transactions.`);
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));

  let check = { checked: 0, withoutFees: 0, findings: [] as Finding[] };
  if (!error && client) {
    try {
      const blocks = new Set<number>();
      for (const span of spans) {
        const block = span.attributes['blockchain.block.number'];
        if (span.name === `confirm ${BASE_SEPOLIA_CHAIN_ID}` && typeof block === 'number') {
          blocks.add(block);
        }
      }
      const sealed = new Map<string, SealedReceipt>();
      for (const block of blocks) {
        const receipts = (await client.request({
          method: 'eth_getBlockReceipts' as never,
          params: [numberToHex(block)] as never,
        })) as SealedReceipt[] | null;
        for (const receipt of receipts ?? [])
          sealed.set(receipt.transactionHash.toLowerCase(), receipt);
      }
      check = compareFees(spans, BASE_SEPOLIA_CHAIN_ID, sealed);
      if (check.checked < minChecked) {
        error = `only ${check.checked} transactions could be checked (at least ${minChecked} needed)`;
        kind = 'setup';
      }
    } catch (caught) {
      error = safeErrorMessage(caught);
      kind = errorKind(caught);
    }
  }

  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : check.findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings: error ? [] : check.findings,
    durationMs: Date.now() - startedAt.getTime(),
    watched: watched.size,
    checked: check.checked,
    withoutFees: check.withoutFees,
    exportErrors: errors,
  };
}
