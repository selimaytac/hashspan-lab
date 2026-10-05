import { withHashspan } from '@hashspan/x402';
import {
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
} from '@hashspan-lab/common';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { x402Client } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, erc20Abi, type Hash, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { PAY_STEP, paymentExpectations, ROOT_SPAN } from './expectations.js';
import { PAID_URL, type PaymentAsset, paidApi } from './paid-api.js';

export const SCENARIO = 'x402';
export const NETWORK = `eip155:${BASE_SEPOLIA_CHAIN_ID}` as const;
/** Base Sepolia's USDC, with the EIP-712 domain from the x402 SDK's asset table for `eip155:84532`. */
export const BASE_SEPOLIA_USDC: PaymentAsset = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  name: 'USDC',
  version: '2',
};
/** 0.001 USDC (6 decimals). The account pays itself, so a run moves no funds away. */
export const PRICE = 1_000n;

export interface ScenarioOptions {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Verifies and settles the payment: the public testnet facilitator, or one in process on a local chain. */
  facilitator: FacilitatorClient;
  asset: PaymentAsset;
  /** Whether receipts carry an L1 data fee (Base Sepolia: yes; Anvil: no). */
  opStack: boolean;
  /** Receipt polling interval in ms; viem's default for the chain when unset. */
  pollingInterval?: number;
}

/** One line of the run ledger: counts, outcomes and tx hashes only, never a key, an RPC URL or an address. */
export interface PaymentSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: 'pass' | 'fail' | 'error';
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  /** The facilitator's settling transaction, when the payment was settled. */
  settlementTxHash: Hash | null;
  exportErrors: string[];
}

/**
 * The agent pays for one request to a paid API with x402's `exact` scheme (an EIP-3009 authorization), in a step
 * span under one root span. The API runs in this process and pays the agent's own account, so only the
 * facilitator's gas is spent. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { env, log, facilitator, asset, opStack, pollingInterval }: ScenarioOptions,
): Promise<PaymentSummary> {
  const startedAt = new Date();
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let settlementTxHash: Hash | null = null;
  let expectations: ReturnType<typeof paymentExpectations> = [];
  let hashspan: ReturnType<typeof withHashspan> | undefined;
  try {
    const { privateKey, rpcUrl } = readBaseSepoliaEnv(env);
    const polling = pollingInterval === undefined ? {} : { pollingInterval };
    const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), ...polling });
    await assertChainId(reader, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia');
    const account = labAccount(privateKey);

    // The agent signs and pays no gas: what it needs is the token, not ether.
    const balance = await reader.readContract({
      address: asset.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (balance < PRICE) {
      throw new LabSetupError(
        `The lab account holds ${balance} of the payment token, the API costs ${PRICE}: fund it with test USDC from the Circle faucet.`,
      );
    }

    const fetchPaid = await paidApi({
      facilitator,
      network: NETWORK,
      asset,
      price: PRICE,
      payTo: account.address,
    });
    const client = new x402Client();
    // Before any other hook, as the @hashspan/x402 README asks.
    hashspan = withHashspan(client, { reader });
    registerExactEvmScheme(client, { signer: account, networks: [NETWORK] });
    // The API is ours, but the agent still refuses to pay more than this run's price, in this asset only.
    client.setSpendControls({
      maxAmountPerPayment: '$0.01',
      allowedAssets: [
        { network: NETWORK, asset: asset.address, maxAmountPerPayment: String(PRICE) },
      ],
    });
    expectations = paymentExpectations({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      payer: account.address.toLowerCase(),
      recipient: account.address.toLowerCase(),
      asset: asset.address.toLowerCase(),
      amount: PRICE,
      opStack,
    });

    const tracer = trace.getTracer('hashspan-lab-x402');
    const status = await tracer.startActiveSpan(ROOT_SPAN, async (root) => {
      try {
        return await tracer.startActiveSpan(PAY_STEP, async (span) => {
          try {
            const response = await wrapFetchWithPayment(fetchPaid, client)(PAID_URL);
            await response.body?.cancel();
            return response.status;
          } finally {
            span.end();
          }
        });
      } finally {
        root.end();
      }
    });
    log(`Paid API answered ${status}.`);
    // Not a finding: a refused or failed settlement is the facilitator's or the account's, not hashspan's.
    if (status !== 200) throw new LabSetupError(`The paid API answered ${status}, not 200.`);
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(
    async () => (await hashspan?.flush({ timeoutMs: 60_000 })) ?? true,
  );
  const payment = spans.find((span) => span.name === `payment ${BASE_SEPOLIA_CHAIN_ID}`);
  const hash = payment?.attributes['blockchain.tx.hash'];
  if (typeof hash === 'string') settlementTxHash = hash as Hash;
  const findings = error
    ? []
    : [...checkSpans(spans, expectations), ...linkFindings(spans, payment)];
  return {
    scenario: SCENARIO,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    settlementTxHash,
    exportErrors: errors,
  };
}

/** The confirm span of the settling transaction links to the payment span and records the same hash. */
export function linkFindings(
  spans: readonly ReadableSpan[],
  payment: ReadableSpan | undefined,
): Finding[] {
  if (!payment) return [];
  const expectation = `confirm ${BASE_SEPOLIA_CHAIN_ID} linked to the payment`;
  const hash = payment.attributes['blockchain.tx.hash'];
  const confirm = spans.find(
    (span) =>
      span.name === `confirm ${BASE_SEPOLIA_CHAIN_ID}` &&
      span.attributes['blockchain.tx.hash'] === hash,
  );
  if (!confirm) return [{ expectation, message: 'no confirm span records the settlement hash' }];
  const linked = confirm.links.some((link) => link.context.spanId === payment.spanContext().spanId);
  return linked
    ? []
    : [{ expectation, message: 'the confirm span does not link to the payment span' }];
}
