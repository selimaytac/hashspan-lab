import { withHashspan } from '@hashspan/viem';
import {
  assertBalance,
  assertChainId,
  checkSpans,
  deployCode,
  type ErrorKind,
  errorKind,
  type Finding,
  LabSetupError,
  type LabTelemetry,
  labAccount,
  readLabTestnetEnv,
  safeErrorMessage,
  type Testnet,
  worstCaseCost,
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  type Hash,
  http,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readCodeUntil } from './code.js';
import { AGENT_NAME, eip7702Expectations, ROOT_SPAN } from './expectations.js';

export const SCENARIO = 'eip7702';
/** Runtime code of the delegate: STOP. A call to the delegated account succeeds and does nothing. */
const DELEGATE_RUNTIME = '0x00';
/** Gas of each type 4 transaction: 21000 plus 25000 per authorization, with room to spare. */
const TYPE4_GAS = 100_000n;

export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
});

export interface ScenarioOptions {
  net: Testnet;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Whether receipts carry an L1 data fee; the testnet's own value unless set (Anvil is never OP-stack). */
  opStack?: boolean;
  pollingInterval?: number;
}

export interface Eip7702Summary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  transactions: { tool: string; hash: string }[];
  setupTxHashes: string[];
  exportErrors: string[];
}

/**
 * Sets and clears an EIP-7702 delegation of a throwaway account, both sponsored by the lab account, which stays a
 * plain account: the throwaway key is made for the run, signs two authorizations and is dropped. The delegate is
 * deployed first (setup, untraced). Besides the span check, reads the throwaway account's code after each step: the
 * delegation indicator after the first, nothing after the second. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { net, env, log, opStack = net.opStack, pollingInterval }: ScenarioOptions,
): Promise<Eip7702Summary> {
  const startedAt = new Date();
  const chainId = net.chain.id;
  const setupTxHashes: Hash[] = [];
  const transactions: { tool: string; hash: string }[] = [];
  const findings: Finding[] = [];
  let delegate: Address = zeroAddress;
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  try {
    const { privateKey, rpcUrl } = readLabTestnetEnv(env, net);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const setup = createPublicClient({ chain: net.chain, transport: http(rpcUrl), ...polling });
    await assertChainId(setup, chainId, net.label);
    const sponsor = labAccount(privateKey);
    const creation = deployCode(DELEGATE_RUNTIME);
    const [{ maxFeePerGas }, deployGas] = await Promise.all([
      setup.estimateFeesPerGas(),
      setup.estimateGas({ account: sponsor.address, data: creation }),
    ]);
    const needed = worstCaseCost({
      gasLimits: [deployGas, TYPE4_GAS, TYPE4_GAS],
      maxFeePerGas,
      value: 0n,
    });
    await assertBalance(setup, sponsor.address, needed, net.label);

    const untraced = createWalletClient({
      account: sponsor,
      chain: net.chain,
      transport: http(rpcUrl),
    });
    const deployment = await untraced.sendTransaction({ data: creation, gas: deployGas });
    setupTxHashes.push(deployment);
    const deployed = await setup.waitForTransactionReceipt({ hash: deployment });
    if (deployed.status !== 'success' || !deployed.contractAddress) {
      throw new LabSetupError(`The delegate was not deployed: ${net.explorer}/tx/${deployment}`);
    }
    delegate = deployed.contractAddress;

    // The authority: a key made for this run and never written down. Its nonce is 0, then 1.
    const authority = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({
      account: sponsor,
      chain: net.chain,
      transport: http(rpcUrl),
      ...polling,
    }).extend(hashspan);
    const reader = createPublicClient({
      chain: net.chain,
      transport: http(rpcUrl),
      ...polling,
    }).extend(hashspan);
    const tracer = trace.getTracer('hashspan-lab-eip7702');
    const step = (
      name: string,
      address: Address,
      nonce: number,
      code: (found: string) => boolean,
    ) =>
      tracer.startActiveSpan(`step ${name}`, async (span) => {
        try {
          const authorization = await authority.signAuthorization({ address, chainId, nonce });
          const hash = await wallet.sendTransaction({
            to: authority.address,
            authorizationList: [authorization],
            gas: TYPE4_GAS,
          });
          transactions.push({ tool: name, hash });
          await reader.waitForTransactionReceipt({ hash });
          const found = await readCodeUntil(
            () => setup.getCode({ address: authority.address }),
            code,
          );
          if (!code(found)) {
            findings.push({
              expectation: `code after step ${name}`,
              message: `the delegated account's code is ${found.length > 2 ? 'set' : 'empty'}`,
            });
          }
        } finally {
          span.end();
        }
      });

    await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        const indicator = concat(['0xef0100', delegate]).toLowerCase();
        await step('delegate', delegate, 0, (found) => found === indicator);
        await step('clear', zeroAddress, 1, (found) => found === '0x');
      } finally {
        root.end();
      }
    });
    log(
      `Set and cleared a delegation on ${net.label}: ${net.explorer}/tx/${transactions.at(-1)?.hash}`,
    );
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush());
  if (!error) {
    findings.push(
      ...checkSpans(
        spans,
        eip7702Expectations({ chainId, delegate: delegate.toLowerCase(), opStack }),
      ),
    );
  }
  return {
    scenario: SCENARIO,
    chainId,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings: error ? [] : findings,
    durationMs: Date.now() - startedAt.getTime(),
    transactions,
    setupTxHashes,
    exportErrors: errors,
  };
}
