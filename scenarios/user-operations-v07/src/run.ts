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
  type Address,
  createPublicClient,
  createWalletClient,
  type Hash,
  type Hex,
  http,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { createBundlerClient, type SmartAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import type { Bundler } from './bundlers.js';
import {
  AGENT_NAME,
  ROOT_SPAN,
  type SentOperation,
  stepName,
  userOperationExpectations,
} from './expectations.js';
import { isPrefundError, type PreparedGas, requiredPrefund, topUpFor } from './prefund.js';

export const SCENARIO = 'user-operations-v07';
export const EXPLORER = 'https://sepolia.basescan.org';
/** Gas of the seed an empty smart account gets so that its first operation can be simulated, deployment included. */
const SEED_GAS = 1_500_000n;
/** How long the wait for an operation's receipt may take. */
const RECEIPT_TIMEOUT_MS = 180_000;

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

/**
 * A paymaster as viem's bundler client takes it: the same answer for the stub and the final data. Only the local
 * EntryPoint stand-in is sent such an operation, and it does not validate the paymaster; it reports it in the event.
 */
function sponsor(paymaster: Address) {
  return {
    getPaymasterData: async () => ({
      paymaster,
      paymasterData: '0x' as Hex,
      paymasterVerificationGasLimit: 100_000n,
      paymasterPostOpGasLimit: 50_000n,
    }),
  };
}

/** Builds the smart account the run sends from, owned by the lab account. */
export type SmartAccountFactory = (
  client: PublicClient,
  owner: LocalAccount,
) => Promise<SmartAccount>;

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** The bundlers to send through, one operation each, in order; called in the run, so a bad choice is its setup error. */
  bundlers: () => readonly Bundler[];
  smartAccount: SmartAccountFactory;
  /**
   * Confirmations to wait for the smart account's top-up and for each bundle before the next operation. Base's public
   * RPC answers with a flashblocks preconfirmation, while bundlers simulate against the last sealed block: without
   * the wait, a bundler sees no top-up (AA21) or no account yet, so the next operation would try to deploy it again
   * (AA10). So 2 on Base Sepolia; a local Anvil mines no further block, so 1 there.
   */
  confirmations: number;
  /** Receipt polling interval in ms, for the chain and the bundlers; viem's default when unset. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes, bundler names and hashes only, never a key, a URL or an address. */
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
  /** The operations sent, by bundler name, in order. */
  /** The operations sent, by bundler. `sponsored` when a paymaster paid; its address stays out of the ledger. */
  userOperations: { bundler: string; userOpHash: string; sponsored?: boolean }[];
  setupTxHashes: Hash[];
  exportErrors: string[];
}

/**
 * A SimpleAccount for EntryPoint v0.7 owned by the lab account sends one user operation with two calls through each
 * bundler, each in a step span under one root span, and waits for its receipt; the first operation deploys the
 * account. The account pays its own gas: before each operation the bundler prepares it, and when the account holds
 * less than the operation's required prefund (every gas limit at its max fee, which is what the bundler simulates),
 * the lab account tops it up to twice that (setup, not traced). Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  {
    env,
    log,
    bundlers: chooseBundlers,
    smartAccount,
    confirmations,
    pollingInterval,
  }: ScenarioOptions,
): Promise<UserOperationSummary> {
  const startedAt = new Date();
  const setupTxHashes: Hash[] = [];
  const sent: SentOperation[] = [];
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let sender: string | undefined;
  try {
    const bundlers = chooseBundlers();
    if (bundlers.length === 0) throw new LabSetupError('No bundler to send through');
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(client, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    const owner = labAccount(privateKey);
    const account = await smartAccount(client as PublicClient, owner);
    sender = account.address.toLowerCase();

    const wallet = createWalletClient({
      account: owner,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
    const calls = [
      { to: owner.address, value: 1n },
      { to: owner.address, data: '0x' as const },
    ];
    /** Sends `value` to the smart account from the lab account and waits for it (setup, untraced). */
    const topUp = async (value: bigint) => {
      const { maxFeePerGas } = await client.estimateFeesPerGas();
      await assertBalance(
        client,
        owner.address,
        worstCaseCost({ gasLimits: [21_000n], maxFeePerGas, value }),
        'Base Sepolia',
      );
      const hash = await wallet.sendTransaction({ to: account.address, value });
      setupTxHashes.push(hash);
      const { status } = await client.waitForTransactionReceipt({ hash, confirmations });
      if (status !== 'success') {
        throw new LabSetupError(`The smart account was not topped up: ${EXPLORER}/tx/${hash}`);
      }
    };
    /**
     * Funds the account for its next operation through one bundler, as that bundler prepares it with its own fees: on
     * an OP-stack chain its preVerificationGas carries the L1 data fee divided by the fee, so only an estimate at the
     * real fee gives the prefund it checks. The estimate simulates the operation, so an empty account first gets a
     * seed (one operation's worst case at the chain's fees); while the bundler still finds too little to simulate
     * (AA21), the account's ether is doubled and the estimate made again, at most three times. Then the account is
     * topped up to twice the prepared operation's prefund when it holds less.
     */
    const fundFor = async (prepare: () => Promise<PreparedGas>) => {
      if ((await client.getBalance({ address: account.address })) === 0n) {
        const { maxFeePerGas } = await client.estimateFeesPerGas();
        await topUp(worstCaseCost({ gasLimits: [SEED_GAS], maxFeePerGas, value: 1n }));
      }
      for (let attempt = 1; ; attempt++) {
        let prepared: PreparedGas;
        try {
          prepared = await prepare();
        } catch (caught) {
          if (attempt === 3 || !isPrefundError(caught)) throw caught;
          await topUp(await client.getBalance({ address: account.address }));
          continue;
        }
        const held = await client.getBalance({ address: account.address });
        const missing = topUpFor(held, requiredPrefund(prepared));
        if (missing > 0n) await topUp(missing);
        return;
      }
    };

    const tracer = trace.getTracer('hashspan-lab-user-operations-v07');
    await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        for (const [index, bundler] of bundlers.entries()) {
          // The chain comes from `client`, so the send span starts before the bundler answers (no ADR 0009 delay).
          const bundlerClient = createBundlerClient({
            account,
            client,
            transport: http(bundler.url),
            ...(bundler.estimateFeesPerGas
              ? { userOperation: { estimateFeesPerGas: bundler.estimateFeesPerGas } }
              : {}),
            ...(bundler.paymaster ? { paymaster: sponsor(bundler.paymaster) } : {}),
            ...polling,
          }).extend(hashspan);
          await fundFor(() => bundlerClient.prepareUserOperation({ calls }));
          await tracer.startActiveSpan(stepName(bundler.name), async (span) => {
            try {
              const hash = await bundlerClient.sendUserOperation({ calls });
              sent.push({
                bundler: bundler.name,
                userOpHash: hash.toLowerCase(),
                paymaster: bundler.paymaster?.toLowerCase(),
              });
              const receipt = await bundlerClient.waitForUserOperationReceipt({
                hash,
                timeout: RECEIPT_TIMEOUT_MS,
              });
              const bundle = receipt.receipt.transactionHash;
              log(`${bundler.name}: success ${receipt.success}, bundle ${EXPLORER}/tx/${bundle}`);
              // The next bundler must see the account deployed and its nonce used: wait for a sealed block. The
              // client is not traced, so this adds no confirm span.
              if (index < bundlers.length - 1) {
                await client.waitForTransactionReceipt({ hash: bundle, confirmations });
              }
            } finally {
              span.end();
            }
          });
        }
      } finally {
        root.end();
      }
    });
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush({ timeoutMs: 60_000 }));
  const findings =
    error || sender === undefined
      ? []
      : checkSpans(
          spans,
          userOperationExpectations({ chainId: BASE_SEPOLIA_CHAIN_ID, sender, operations: sent }),
        );
  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    userOperations: sent.map(({ bundler, userOpHash, paymaster }) => ({
      bundler,
      userOpHash,
      ...(paymaster ? { sponsored: true } : {}),
    })),
    setupTxHashes,
    exportErrors: errors,
  };
}
