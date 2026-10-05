import { LabSetupError } from '@hashspan-lab/common';
import { createPublicClient, http } from 'viem';

/** The operation's fees, as a bundler wants them. */
export type FeeEstimator = () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;

/** One bundler the run sends through: a name for spans and summaries, and a URL that never leaves the process. */
export interface Bundler {
  name: string;
  url: string;
  /** The bundler's own fee estimate; the chain's when unset. */
  estimateFeesPerGas?: FeeEstimator;
}

/**
 * The hosted bundlers for Base Sepolia that need no API key (docs/research/entrypoint-v07-2026-10-04.md), each with the
 * method that answers its fee recommendation. Both list EntryPoint v0.7 in `eth_supportedEntryPoints`.
 */
export const HOSTED_BUNDLERS = {
  // 20 requests a minute per IP; `fast` sits above the chain's estimate, which can be below its floor.
  pimlico: {
    url: 'https://public.pimlico.io/v2/84532/rpc',
    feeMethod: 'pimlico_getUserOperationGasPrice',
  },
  // No documented limit for the public endpoint; the keyed Starter plan allows 10 requests a second.
  candide: { url: 'https://api.candide.dev/public/v3/84532', feeMethod: 'voltaire_feesPerGas' },
} as const;
export type HostedBundlerName = keyof typeof HOSTED_BUNDLERS;

/** Both, Pimlico first: its operation deploys the account, Candide's then sends from the deployed one. */
export const DEFAULT_BUNDLERS: readonly HostedBundlerName[] = ['pimlico', 'candide'];

const isHosted = (name: string): name is HostedBundlerName => Object.hasOwn(HOSTED_BUNDLERS, name);

/**
 * The bundlers of `USER_OPERATIONS_V07_BUNDLERS` (comma-separated names, in order), or both by default. Only names are
 * accepted, so no URL with a token reaches the configuration, the spans or the summary.
 */
export function bundlerNames(env: Record<string, string | undefined>): HostedBundlerName[] {
  const raw = env.USER_OPERATIONS_V07_BUNDLERS?.trim();
  if (!raw) return [...DEFAULT_BUNDLERS];
  const names = raw.split(',').map((name) => name.trim().toLowerCase());
  const unknown = names.filter((name) => !isHosted(name));
  if (unknown.length > 0 || names.length === 0) {
    throw new LabSetupError(
      `USER_OPERATIONS_V07_BUNDLERS takes names from: ${Object.keys(HOSTED_BUNDLERS).join(', ')}`,
    );
  }
  if (new Set(names).size !== names.length) {
    throw new LabSetupError('USER_OPERATIONS_V07_BUNDLERS names a bundler twice');
  }
  return names as HostedBundlerName[];
}

/** Reads a `{ maxFeePerGas, maxPriorityFeePerGas }` answer, at the top level or under `fast` (Pimlico). */
export function parseFees(answer: unknown): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const fees = (answer && typeof answer === 'object' && 'fast' in answer ? answer.fast : answer) as
    | { maxFeePerGas?: unknown; maxPriorityFeePerGas?: unknown }
    | null
    | undefined;
  const { maxFeePerGas, maxPriorityFeePerGas } = fees ?? {};
  if (typeof maxFeePerGas !== 'string' || typeof maxPriorityFeePerGas !== 'string') {
    throw new Error('The bundler answered no fee recommendation');
  }
  return { maxFeePerGas: BigInt(maxFeePerGas), maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas) };
}

/** A hosted bundler by name, with its fee recommendation as the operation's fees. */
export function hostedBundler(name: HostedBundlerName): Bundler {
  const { url, feeMethod } = HOSTED_BUNDLERS[name];
  const rpc = createPublicClient({ transport: http(url) });
  return {
    name,
    url,
    estimateFeesPerGas: async () => parseFees(await rpc.request({ method: feeMethod as never })),
  };
}
