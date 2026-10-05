import { withHashspan } from '@hashspan/viem';
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
import { trace } from '@opentelemetry/api';
import {
  type Account,
  createPublicClient,
  createWalletClient,
  type Hash,
  http,
  type PublicClient,
} from 'viem';
import { createBundlerClient, type SmartAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { AGENT_NAME, ROOT_SPAN, STEP, userOperationExpectations } from './expectations.js';

export const SCENARIO = 'user-operations';
export const EXPLORER = 'https://sepolia.basescan.org';
/** Gas the smart account's ether must cover for one operation, deployment included, before the margin. */
const OPERATION_GAS = 1_500_000n;
/** How long the wait for the operation's receipt may take. */
const RECEIPT_TIMEOUT_MS = 180_000;

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

/** Builds the smart account the run sends from, owned by the lab account. */
export type SmartAccountFactory = (client: PublicClient, owner: Account) => Promise<SmartAccount>;

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** The ERC-4337 bundler's URL. */
  bundlerUrl: string;
  smartAccount: SmartAccountFactory;
  /** The operation's fees, when the bundler wants its own (Pimlico); the chain's estimate when unset. */
  estimateFeesPerGas?: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /**
   * Confirmations to wait for the smart account's top-up. Base's public RPC answers with a flashblocks preconfirmation,
   * and the bundler simulates against the last sealed block, where the top-up is not yet (AA21 "didn't pay prefund");
   * so 2 on Base Sepolia. A local Anvil mines no further block, so 1 there.
   */
  topUpConfirmations: number;
  /** Receipt polling interval in ms, for the chain and the bundler; viem's default when unset. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes and hashes only, never a key, a URL or an address. */
export interface UserOperationSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  userOpHash: Hash | null;
  setupTxHashes: Hash[];
  exportErrors: string[];
}

/**
 * A smart account owned by the lab account sends one user operation with two calls through viem's bundler client,
 * in a step span under one root span, and waits for its receipt. The smart account pays its own gas: when its ether
 * is below the worst case, the lab account tops it up first (setup, not traced). Never throws; the outcome is in the
 * summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  {
    env,
    log,
    bundlerUrl,
    smartAccount,
    estimateFeesPerGas,
    topUpConfirmations,
    pollingInterval,
  }: ScenarioOptions,
): Promise<UserOperationSummary> {
  const startedAt = new Date();
  const setupTxHashes: Hash[] = [];
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let userOpHash: Hash | null = null;
  let expectations: ReturnType<typeof userOperationExpectations> = [];
  try {
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(client, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    const owner = labAccount(privateKey);
    const account = await smartAccount(client as PublicClient, owner);

    const { maxFeePerGas } = await (estimateFeesPerGas ?? (() => client.estimateFeesPerGas()))();
    const needed = worstCaseCost({ gasLimits: [OPERATION_GAS], maxFeePerGas, value: 1n });
    const held = await client.getBalance({ address: account.address });
    if (held < needed) {
      const topUp = needed - held;
      await assertBalance(
        client,
        owner.address,
        worstCaseCost({ gasLimits: [21_000n], maxFeePerGas, value: topUp }),
        'Base Sepolia',
      );
      const wallet = createWalletClient({
        account: owner,
        chain: baseSepolia,
        transport: http(rpcUrl),
      });
      const hash = await wallet.sendTransaction({ to: account.address, value: topUp });
      setupTxHashes.push(hash);
      const { status } = await client.waitForTransactionReceipt({
        hash,
        confirmations: topUpConfirmations,
      });
      if (status !== 'success') {
        throw new LabSetupError(`The smart account was not topped up: ${EXPLORER}/tx/${hash}`);
      }
    }
    expectations = userOperationExpectations({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      sender: account.address.toLowerCase(),
    });

    // The chain comes from `client`, so the send span starts before the bundler answers (no ADR 0009 delay).
    const bundler = createBundlerClient({
      account,
      client,
      transport: http(bundlerUrl),
      ...(estimateFeesPerGas ? { userOperation: { estimateFeesPerGas } } : {}),
      ...polling,
    }).extend(hashspan);
    const tracer = trace.getTracer('hashspan-lab-user-operations');
    await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        await tracer.startActiveSpan(STEP, async (span) => {
          try {
            const hash = await bundler.sendUserOperation({
              calls: [
                { to: owner.address, value: 1n },
                { to: owner.address, data: '0x' },
              ],
            });
            userOpHash = hash;
            const receipt = await bundler.waitForUserOperationReceipt({
              hash,
              timeout: RECEIPT_TIMEOUT_MS,
            });
            log(
              `User operation: success ${receipt.success}, bundle ${EXPLORER}/tx/${receipt.receipt.transactionHash}`,
            );
          } finally {
            span.end();
          }
        });
      } finally {
        root.end();
      }
    });
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));
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
    userOpHash,
    setupTxHashes,
    exportErrors: errors,
  };
}
