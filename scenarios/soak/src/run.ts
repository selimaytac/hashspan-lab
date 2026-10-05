import { withHashspan } from '@hashspan/viem';
import {
  assertBalance,
  assertChainId,
  checkSpans,
  type ErrorKind,
  errorKind,
  type Finding,
  type LabTelemetry,
  labAccount,
  readLabTestnetEnv,
  type SpanExpectation,
  safeErrorMessage,
  type Testnet,
  worstCaseCost,
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import type { InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { createPublicClient, createWalletClient, type Hash, http } from 'viem';
import {
  histogramCounts,
  type LoadStats,
  loadFindings,
  loadStats,
  metricFindings,
} from './load.js';

export const SCENARIO = 'soak';
export const AGENT_NAME = 'soak-agent';
const ROOT_SPAN = 'soak run';

// Background mode: each send is confirmed without a wait, so many confirmations run at once.
export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
  confirm: { mode: 'background' },
});

export interface ScenarioOptions {
  net: Testnet;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  transactions: number;
  /** In-memory exporter of a metric reader passed to `startTelemetry`, for the histogram counts. */
  metrics: InMemoryMetricExporter;
  /** Whether receipts carry an L1 data fee; the testnet's own value unless set (Anvil is never OP-stack). */
  opStack?: boolean;
  /** Receipt polling interval in ms; viem's default for the chain when unset. */
  pollingInterval?: number;
}

export interface SoakSummary extends LoadStats {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  transactions: number;
  /** Heap in use before the first send and after the flush, in MB: a leak grows with the transaction count. */
  heapMb: { before: number; after: number };
  exportErrors: string[];
}

/** What every one of the run's transactions must leave behind, besides `loadFindings` and the metric counts. */
export function soakExpectations(
  chainId: number,
  count: number,
  opStack: boolean,
): SpanExpectation[] {
  return [
    {
      name: `send ${chainId}`,
      count,
      parent: ROOT_SPAN,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'gen_ai.agent.name': AGENT_NAME,
      },
    },
    {
      name: `confirm ${chainId}`,
      count,
      where: { 'blockchain.tx.status': 'success' },
      parent: ROOT_SPAN,
      sameTrace: true,
      attributes: {
        'blockchain.tx.hash': /^0x[0-9a-f]{64}$/,
        'blockchain.block.number': { present: true },
        'blockchain.tx.gas.used': { present: true },
        'blockchain.tx.fee': /^\d+$/,
        ...(opStack ? { 'blockchain.tx.l1_fee': /^\d+$/ } : {}),
      },
    },
  ];
}

const heapMb = (): number => Math.round(process.memoryUsage().heapUsed / 1e5) / 10;

/**
 * Sends `transactions` self-transfers of 1 wei one after another without waiting, lets background confirmation
 * confirm them all at once, then ends the telemetry and checks spans and metrics. Never throws.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { net, env, log, transactions, metrics, opStack = net.opStack, pollingInterval }: ScenarioOptions,
): Promise<SoakSummary> {
  const startedAt = new Date();
  const chainId = net.chain.id;
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  const before = heapMb();
  try {
    const { privateKey, rpcUrl } = readLabTestnetEnv(env, net);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const setup = createPublicClient({ chain: net.chain, transport: http(rpcUrl), ...polling });
    await assertChainId(setup, chainId, net.label);
    const account = labAccount(privateKey);
    const { maxFeePerGas } = await setup.estimateFeesPerGas();
    const needed = worstCaseCost({
      gasLimits: Array.from({ length: transactions }, () => 21_000n),
      maxFeePerGas,
      value: BigInt(transactions),
    });
    await assertBalance(setup, account.address, needed, net.label);

    const wallet = createWalletClient({
      account,
      chain: net.chain,
      transport: http(rpcUrl),
      ...polling,
    }).extend(hashspan);
    const hashes: Hash[] = [];
    await trace.getTracer('hashspan-lab-soak').startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        for (let i = 0; i < transactions; i++) {
          hashes.push(
            await wallet.sendTransaction({ to: account.address, value: 1n, gas: 21_000n }),
          );
        }
      } finally {
        root.end();
      }
    });
    log(`Sent ${hashes.length} transactions on ${net.label}; ${net.explorer}/tx/${hashes.at(-1)}`);
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  // Long enough for every receipt of a full run on a slow chain.
  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 180_000 }));
  const findings = error
    ? []
    : [
        ...checkSpans(spans, soakExpectations(chainId, transactions, opStack)),
        ...loadFindings(spans, chainId),
        ...metricFindings(histogramCounts(metrics.getMetrics()), transactions),
      ];
  return {
    scenario: SCENARIO,
    chainId,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    transactions,
    ...loadStats(spans, chainId),
    heapMb: { before, after: heapMb() },
    exportErrors: errors,
  };
}
