import { withHashspan } from '@hashspan/cdp';
import {
  assertBalance,
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  checkSpans,
  type ErrorKind,
  errorKind,
  type Finding,
  type LabTelemetry,
  safeErrorMessage,
  worstCaseCost,
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import { createPublicClient, type Hash, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readCdpEnv } from './env.js';
import { AGENT_NAME, cdpExpectations, ROOT_SPAN } from './expectations.js';

export const SCENARIO = 'cdp';
/** The CDP server account the lab reuses every day; fund it once on Base Sepolia. */
export const ACCOUNT_NAME = 'hashspan-lab';
/** The CDP smart account the lab reuses, owned by the server account; Base Sepolia sponsors its user operations. */
export const SMART_ACCOUNT_NAME = 'hashspan-lab-smart';
const NETWORK = 'base-sepolia';
/** How long the wait for the user operation may take; the SDK's default is 30 s. */
const USER_OPERATION_TIMEOUT_S = 120;

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
  /** Reader RPC URL; Base Sepolia's public RPC when unset. */
  rpcUrl?: string;
  /** CDP API base path; the CDP API when unset (a local stand-in in tests). */
  basePath?: string;
  /** Receipt polling interval in ms; viem's default for the chain when unset. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes and tx hashes only, never a key, an RPC URL or an address. */
export interface CdpSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  txHashes: Hash[];
  userOpHashes: Hash[];
  exportErrors: string[];
}

/**
 * A CDP server account sends two transfers to itself, each in a step span under one root span: one with the
 * account's `sendTransaction`, confirmed in the background through the reader, and one through the account scoped to
 * Base Sepolia, which waits for its receipt through CDP's node. Then the account's smart account sends a user
 * operation with two calls and waits for it. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { env, log, opStack, rpcUrl, basePath, pollingInterval }: ScenarioOptions,
): Promise<CdpSummary> {
  const startedAt = new Date();
  const txHashes: Hash[] = [];
  const userOpHashes: Hash[] = [];
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let expectations: ReturnType<typeof cdpExpectations> = [];
  let hashspan: ReturnType<typeof withHashspan> | undefined;
  try {
    const credentials = readCdpEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(reader, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');

    const { CdpClient } = await import('@coinbase/cdp-sdk');
    const cdp = new CdpClient({ ...credentials, ...(basePath ? { basePath } : {}) });
    // Right after creating the client, before its first transaction.
    hashspan = withHashspan(cdp, { reader, agent: { name: AGENT_NAME } });
    const account = await cdp.evm.getOrCreateAccount({ name: ACCOUNT_NAME });
    const { maxFeePerGas } = await reader.estimateFeesPerGas();
    await assertBalance(
      reader,
      account.address,
      worstCaseCost({ gasLimits: [21_000n, 21_000n], maxFeePerGas, value: 3n }),
      'Base Sepolia',
    );
    const smartAccount = await cdp.evm.getOrCreateSmartAccount({
      name: SMART_ACCOUNT_NAME,
      owner: account,
    });
    expectations = cdpExpectations({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      from: account.address.toLowerCase(),
      smartAccount: smartAccount.address.toLowerCase(),
      opStack,
    });

    const tracer = trace.getTracer('hashspan-lab-cdp');
    const step = <T>(name: string, run: () => Promise<T>): Promise<T> =>
      tracer.startActiveSpan(`step ${name}`, async (span) => {
        try {
          return await run();
        } finally {
          span.end();
        }
      });
    const self = account.address;

    await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        const sent = await step('account', () =>
          account.sendTransaction({ network: NETWORK, transaction: { to: self, value: 1n } }),
        );
        txHashes.push(sent.transactionHash);
        const scoped = await account.useNetwork(NETWORK);
        const receipt = await step('scoped', async () => {
          const { transactionHash } = await scoped.sendTransaction({
            transaction: { to: self, value: 2n },
          });
          txHashes.push(transactionHash);
          return scoped.waitForTransactionReceipt({ hash: transactionHash });
        });
        log(`Network-scoped transfer: ${receipt.status}.`);
        // Two calls without value, so the smart account needs no ether of its own.
        const operation = await step('smart', async () => {
          const { userOpHash } = await smartAccount.sendUserOperation({
            network: NETWORK,
            calls: [
              { to: self, value: 0n, data: '0x' },
              { to: self, value: 0n, data: '0x' },
            ],
          });
          userOpHashes.push(userOpHash);
          return smartAccount.waitForUserOperation({
            userOpHash,
            waitOptions: { timeoutSeconds: USER_OPERATION_TIMEOUT_S },
          });
        });
        log(`User operation: ${operation.status}.`);
      } finally {
        root.end();
      }
    });
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(
    async () => (await hashspan?.flush({ timeoutMs: 60_000 })) ?? true,
  );
  const findings = error ? [] : checkSpans(spans, expectations);
  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    txHashes,
    userOpHashes,
    exportErrors: errors,
  };
}
