import { withHashspan } from '@hashspan/viem';
import {
  assertBalance,
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  checkSpans,
  deployCode,
  type ErrorKind,
  errorKind,
  type Finding,
  LabSetupError,
  type LabTelemetry,
  labAccount,
  readBaseSepoliaEnv,
  revertingWith,
  safeErrorMessage,
  worstCaseCost,
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import { createPublicClient, createWalletClient, type Hash, type Hex, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { type PublicRpcFallback, publicRpcFallback, withoutEip5792 } from './eip5792.js';
import { AGENT_NAME, batchExpectations, ROOT_SPAN } from './expectations.js';

export const SCENARIO = 'call-batches';
export const EXPLORER = 'https://sepolia.basescan.org';
/** How long each wait for a batch's status may take. */
const STATUS_TIMEOUT_MS = 60_000;

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** See `ExpectationOptions.opStack`. */
  opStack: boolean;
  /** Receipt polling interval in ms; viem's default for the chain when unset. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes and tx hashes only, never a key, an RPC URL or an address. */
export interface BatchSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  /** Whether viem falls back to plain transactions on the RPC itself (Base's public RPC: not with viem 2.57). */
  publicRpcFallback: PublicRpcFallback | null;
  setupTxHashes: Hash[];
  exportErrors: string[];
}

/**
 * Sends two EIP-5792 batches through viem's `experimental_fallback`, each in a step span under one root span: two
 * transfers with `sendCallsSync`, then a transfer and a call that fails to send with `sendCalls` and
 * `waitForCallsStatus`. The wallet's transport answers the `wallet_*` methods as a wallet without EIP-5792, so viem
 * sends plain transactions. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { env, log, opStack, pollingInterval }: ScenarioOptions,
): Promise<BatchSummary> {
  const startedAt = new Date();
  const setupTxHashes: Hash[] = [];
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let fallback: PublicRpcFallback | null = null;
  try {
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const setup = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(setup, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    const account = labAccount(privateKey);

    // A contract that reverts every call: the second call of the second batch cannot be sent to it.
    const creation = deployCode(revertingWith('0x'));
    const [{ maxFeePerGas }, deployGas] = await Promise.all([
      setup.estimateFeesPerGas(),
      setup.estimateGas({ account: account.address, data: creation }),
    ]);
    const needed = worstCaseCost({
      gasLimits: [deployGas, 21_000n, 21_000n, 21_000n],
      maxFeePerGas,
      value: 4n,
    });
    await assertBalance(setup, account.address, needed, 'Base Sepolia');
    const deployer = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
    const deployment = await deployer.sendTransaction({ data: creation, gas: deployGas });
    setupTxHashes.push(deployment);
    const { status, contractAddress } = await setup.waitForTransactionReceipt({ hash: deployment });
    if (status !== 'success' || !contractAddress) {
      throw new LabSetupError(
        `The reverting contract was not deployed: ${EXPLORER}/tx/${deployment}`,
      );
    }

    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: withoutEip5792(rpcUrl),
      ...polling,
    }).extend(hashspan);
    const tracer = trace.getTracer('hashspan-lab-call-batches');
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
        const transfers = await step('transfers', () =>
          wallet.sendCallsSync({
            calls: [
              { to: self, value: 1n },
              { to: self, value: 2n },
            ],
            experimental_fallback: true,
            timeout: STATUS_TIMEOUT_MS,
          }),
        );
        log(`Two transfers: ${transfers.status} (${transfers.statusCode}).`);
        // Last: the call that fails to send takes a nonce from the account's nonce manager that no transaction uses.
        const failed = await step('failed-call', async () => {
          const { id } = await wallet.sendCalls({
            calls: [
              { to: self, value: 1n },
              { to: contractAddress, data: '0x12345678' as Hex },
            ],
            experimental_fallback: true,
          });
          return wallet.waitForCallsStatus({ id, timeout: STATUS_TIMEOUT_MS });
        });
        log(`A transfer and a call that fails to send: ${failed.status} (${failed.statusCode}).`);
      } finally {
        root.end();
      }
    });

    fallback = await publicRpcFallback(http(rpcUrl));
    log(`viem's fallback on the RPC itself: ${fallback}.`);
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));
  const findings = error
    ? []
    : checkSpans(spans, batchExpectations({ chainId: BASE_SEPOLIA_CHAIN_ID, opStack }));
  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    publicRpcFallback: fallback,
    setupTxHashes,
    exportErrors: errors,
  };
}
