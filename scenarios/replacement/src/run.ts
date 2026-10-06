import { setTimeout as sleep } from 'node:timers/promises';
import { withHashspan } from '@hashspan/viem';
import {
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  checkSpans,
  type ErrorKind,
  errorKind,
  type Finding,
  type LabTelemetry,
  readBaseSepoliaEnv,
  safeErrorMessage,
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hash,
  http,
  parseGwei,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AGENT_NAME, ROOT_SPAN, replacementExpectations, STEPS } from './expectations.js';
import { replacementLinkFindings } from './links.js';

export const SCENARIO = 'replacement';

/** Where the transfers go: nobody's accounts. */
const RECIPIENT: Address = '0x000000000000000000000000000000000000dead';
const OTHER_RECIPIENT: Address = '0x000000000000000000000000000000000000beef';
/** The replacement pays twice the fee of the original, well above any minimum bump of the transaction pool. */
const LOW = { maxFeePerGas: parseGwei('5'), maxPriorityFeePerGas: parseGwei('1') };
const HIGH = { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('2') };
const TRANSFER_GAS = 21_000n;

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Receipt polling interval in ms of the waits and the replacement check. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes and tx hashes only, never a key, an RPC URL or an address. */
export interface ReplacementSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  transactions: {
    tool: string;
    hash: string;
    status: string | null;
    replacementHash: string | null;
    reason: string | null;
  }[];
  setupTxHashes: Hash[];
  exportErrors: string[];
}

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
        replacementHash: text('blockchain.tx.replacement.hash'),
        reason: text('blockchain.tx.replacement.reason'),
      };
    });
}

/**
 * Replaces a pending transaction three ways on a chain that mines on command: the same transfer with a higher fee
 * (repriced), a zero-value transfer to the sender (cancelled) and a different transfer (replaced). Each step sends the
 * original, starts the wait for its hash, sends the replacement with the same nonce, mines a block, and ends when the
 * wait resolved with the replacement's receipt. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { env, log, pollingInterval = 100 }: ScenarioOptions,
): Promise<ReplacementSummary> {
  const startedAt = new Date();
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let failedStep: string | undefined;
  try {
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const plain = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    await assertChainId(plain, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    // Only a chain that mines on command can hold a transaction pending: Anvil, which answers these two methods.
    await plain.request({ method: 'evm_setAutomine' as never, params: [false] as never });
    const mine = () => plain.request({ method: 'evm_mine' as never, params: [] as never });

    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
      pollingInterval,
    }).extend(hashspan);
    const tracer = trace.getTracer('hashspan-lab-replacement');
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

    const transfers = {
      repriced: {
        original: { to: RECIPIENT, value: 1n },
        replacement: { to: RECIPIENT, value: 1n },
      },
      cancelled: {
        original: { to: RECIPIENT, value: 1n },
        replacement: { to: account.address, value: 0n },
      },
      replaced: {
        original: { to: RECIPIENT, value: 1n },
        replacement: { to: OTHER_RECIPIENT, value: 2n },
      },
    } as const;

    await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        for (const { name } of STEPS) {
          await step(name, async () => {
            const nonce = await plain.getTransactionCount({
              address: account.address,
              blockTag: 'pending',
            });
            const { original, replacement } = transfers[name];
            const first = await wallet.sendTransaction({
              ...original,
              nonce,
              gas: TRANSFER_GAS,
              ...LOW,
            });
            // viem looks for a replacement while it waits: the wait must be running before the replacement exists.
            const waiting = reader.waitForTransactionReceipt({ hash: first, timeout: 30_000 });
            await sleep(4 * pollingInterval);
            const second = await wallet.sendTransaction({
              ...replacement,
              nonce,
              gas: TRANSFER_GAS,
              ...HIGH,
            });
            await mine();
            const receipt = await waiting;
            if (receipt.transactionHash !== second) {
              throw new Error('the wait did not end with the receipt of the replacement');
            }
            log(`${name}: replaced and mined.`);
          });
        }
      } finally {
        root.end();
      }
    });
  } catch (caught) {
    error = failedStep
      ? `step ${failedStep}: ${safeErrorMessage(caught)}`
      : safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));
  const findings = error
    ? []
    : [
        ...checkSpans(spans, replacementExpectations({ chainId: BASE_SEPOLIA_CHAIN_ID })),
        ...replacementLinkFindings(spans, BASE_SEPOLIA_CHAIN_ID),
      ];
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
    setupTxHashes: [],
    exportErrors: errors,
  };
}
