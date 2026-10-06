import { traceTransport, withHashspan } from '@hashspan/viem';
import {
  assertBalance,
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  checkSpans,
  type ErrorKind,
  errorKind,
  type Finding,
  LabSetupError,
  type LabTelemetry,
  labAccount,
  readBaseSepoliaEnv,
  safeErrorMessage,
  worstCaseCost,
} from '@hashspan-lab/common';
import { context, propagation, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { type Address, createPublicClient, createWalletClient, type Hash, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { deployCode, REVERTS, revertAbi, revertingWith } from './contracts.js';
import { AGENT_NAME, BAGGAGE_AGENT_ID, pathsExpectations, ROOT_SPAN } from './expectations.js';

export const SCENARIO = 'paths';
/** The static identity has a name only: the agent id comes from Baggage, which fills what the static fields leave unset. */
const AGENT_BAGGAGE = propagation.createBaggage({ 'gen_ai.agent.id': { value: BAGGAGE_AGENT_ID } });
export const EXPLORER = 'https://sepolia.basescan.org';
/** Gas of each reverting call: explicit, so the call is mined and reverts instead of failing estimation. */
const REVERT_GAS = 100_000n;

// Background mode: every send through an extended client is confirmed even without a wait.
export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
  confirm: { mode: 'background' },
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
export interface PathsSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  transactions: { tool: string; hash: string; status: string | null; feeWei: string | null }[];
  setupTxHashes: Hash[];
  exportErrors: string[];
}

/** The confirm spans of the run as ledger entries, named after the step they ran in. */
function transactionsOf(spans: readonly ReadableSpan[], chainId: number) {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  return spans
    .filter((span) => span.name === `confirm ${chainId}`)
    .map((span) => {
      const parent = span.parentSpanContext ? byId.get(span.parentSpanContext.spanId) : undefined;
      const text = (key: string) => {
        const value = span.attributes[key];
        return typeof value === 'string' ? value : null;
      };
      return {
        tool: parent?.name.replace(/^step /, '') ?? 'unknown',
        hash: text('blockchain.tx.hash') ?? '',
        status: text('blockchain.tx.status'),
        feeWei: text('blockchain.tx.fee'),
      };
    });
}

/**
 * Runs each path once inside a root span, one step span per path, then ends the telemetry and checks the spans. The
 * reverting contracts are deployed first by an untraced client (setup). Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { env, log, opStack, pollingInterval }: ScenarioOptions,
): Promise<PathsSummary> {
  const startedAt = new Date();
  const setupTxHashes: Hash[] = [];
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  // The step a run error came from, so a failed request is told apart from the setup's and the other steps'.
  let failedStep: string | undefined;
  try {
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const setup = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(setup, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    // One account for every client, so its nonce manager counts the nonces of all of them.
    const account = labAccount(privateKey);
    const creations = REVERTS.map(({ data }) => deployCode(revertingWith(data)));
    const [{ maxFeePerGas }, ...deployGas] = await Promise.all([
      setup.estimateFeesPerGas(),
      ...creations.map((data) => setup.estimateGas({ account: account.address, data })),
    ]);
    const needed = worstCaseCost({
      gasLimits: [...deployGas, 21_000n, 21_000n, ...REVERTS.map(() => REVERT_GAS)],
      maxFeePerGas,
      value: 2n,
    });
    await assertBalance(setup, account.address, needed, 'Base Sepolia');

    const untraced = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
    const contracts: Address[] = [];
    for (const [i, data] of creations.entries()) {
      const hash = await untraced.sendTransaction({ data, gas: deployGas[i] });
      setupTxHashes.push(hash);
      const { status, contractAddress } = await setup.waitForTransactionReceipt({ hash });
      if (status !== 'success' || !contractAddress) {
        throw new LabSetupError(`A reverting contract was not deployed: ${EXPLORER}/tx/${hash}`);
      }
      contracts.push(contractAddress);
    }
    log(`Deployed ${contracts.length} reverting contracts.`);

    // The traced wallet sends through traceTransport, so each provider request is a span of its own.
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: traceTransport(http(rpcUrl)),
      ...polling,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
      ...polling,
    }).extend(hashspan);
    const tracer = trace.getTracer('hashspan-lab-paths');
    const step = <T>(name: string, run: () => Promise<T>): Promise<T> =>
      tracer.startActiveSpan(`step ${name}`, async (span) => {
        try {
          return await run();
        } catch (caught) {
          failedStep ??= name;
          throw caught;
        } finally {
          span.end();
        }
      });

    await context.with(propagation.setBaggage(context.active(), AGENT_BAGGAGE), () =>
      tracer.startActiveSpan(ROOT_SPAN, async (root) => {
        try {
          // A send without a wait: background confirmation records the receipt.
          await step('background', () =>
            wallet.sendTransaction({ to: account.address, value: 1n }),
          );
          // A transaction sent by an untraced client, confirmed through watch().
          await step('watch', async () => {
            const hash = await untraced.sendTransaction({ to: account.address, value: 1n });
            hashspan.watch(reader, { hash });
          });
          // Three reverts, each decoded from its own kind of revert data.
          for (const [i, { step: name }] of REVERTS.entries()) {
            await step(name, async () => {
              const hash = await wallet.writeContract({
                address: contracts[i] as Address,
                abi: revertAbi,
                functionName: 'trigger',
                gas: REVERT_GAS,
              });
              await reader.waitForTransactionReceipt({ hash });
            });
          }
        } finally {
          root.end();
        }
      }),
    );
  } catch (caught) {
    error = failedStep
      ? `step ${failedStep}: ${safeErrorMessage(caught)}`
      : safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));
  const findings = error
    ? []
    : checkSpans(spans, pathsExpectations({ chainId: BASE_SEPOLIA_CHAIN_ID, opStack }));
  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    transactions: transactionsOf(spans, BASE_SEPOLIA_CHAIN_ID),
    setupTxHashes,
    exportErrors: errors,
  };
}
