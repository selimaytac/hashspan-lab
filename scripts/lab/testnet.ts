import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address, formatEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TESTNETS, type Testnet, testnet } from '../../packages/common/src/testnets.js';

/** The scenarios that can run on a real testnet, with what each needs. Names are the folders of scenarios/. */
export interface ScenarioNeeds {
  /** Chain ids (`TESTNETS[].id`) the scenario can run on; undefined: any of them. */
  chains?: readonly string[];
  /** Environment variables that must be set, with what they are for. */
  env?: Readonly<Record<string, string>>;
  /** False for a scenario that only reads (it needs no account, sends nothing, costs nothing). */
  sends: boolean;
  note?: string;
}

const BASE = ['base-sepolia'] as const;

export const TESTNET_SCENARIOS: Readonly<Record<string, ScenarioNeeds>> = {
  treasury: { sends: true },
  eip7702: { sends: true },
  soak: { sends: true, note: 'many transactions in a row' },
  paths: { chains: BASE, sends: true },
  'call-batches': { chains: BASE, sends: true },
  'user-operations': { chains: BASE, sends: true, note: 'uses a public bundler' },
  'user-operations-v07': { chains: BASE, sends: true, note: 'uses a public bundler' },
  x402: { chains: BASE, sends: true, note: 'needs test USDC on the account' },
  cdp: {
    chains: BASE,
    sends: true,
    env: {
      CDP_API_KEY_ID: 'your CDP API key id',
      CDP_API_KEY_SECRET: 'your CDP API key secret',
      CDP_WALLET_SECRET: 'your CDP wallet secret',
    },
  },
  'sealed-fees': { chains: BASE, sends: false },
};

export const DEFAULT_TESTNET_SCENARIOS = ['treasury'] as const;

export interface Eligibility {
  run: string[];
  skipped: { name: string; reason: string }[];
}

/** Splits `requested` (names, or `all`) into what can run on `net` with `env`, and what is skipped, with the reason. */
export function chooseScenarios(
  net: Testnet,
  requested: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Eligibility {
  const names = requested.includes('all') ? Object.keys(TESTNET_SCENARIOS) : requested;
  const result: Eligibility = { run: [], skipped: [] };
  for (const name of names) {
    const needs = TESTNET_SCENARIOS[name];
    if (!needs) {
      throw new Error(
        `unknown scenario ${name}; one of: ${Object.keys(TESTNET_SCENARIOS).join(', ')}`,
      );
    }
    if (needs.chains && !needs.chains.includes(net.id)) {
      result.skipped.push({ name, reason: `runs on ${needs.chains.join(', ')} only` });
      continue;
    }
    const missing = Object.entries(needs.env ?? {}).filter(([variable]) => !env[variable]);
    if (missing.length > 0) {
      result.skipped.push({
        name,
        reason: `needs ${missing.map(([variable, what]) => `${variable} (${what})`).join(', ')}`,
      });
      continue;
    }
    result.run.push(name);
  }
  return result;
}

const SECRET_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function isSecretKey(value: string): value is Hex {
  return SECRET_PATTERN.test(value);
}

/** Replaces every secret (and a hex secret without its 0x prefix) in `text`, for output that comes from a child. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const bare = secret.startsWith('0x') ? secret.slice(2) : secret;
    for (const variant of new Set([secret, bare])) out = out.split(variant).join('[redacted]');
  }
  return out;
}

/** What the RPC's `eth_chainId` may be: a chain of the testnet allowlist, and the one that was chosen. */
export function checkRpcChain(net: Testnet, reported: number): void {
  const known = TESTNETS.find((entry) => entry.chain.id === reported);
  if (!known) {
    const allowed = TESTNETS.map((t) => `${t.label} ${t.chain.id}`).join(', ');
    throw new Error(
      `the RPC reports chain id ${reported}, which is not one of the testnets of this lab (${allowed}); mainnets and unknown chains are refused`,
    );
  }
  if (known.id !== net.id) {
    throw new Error(
      `the RPC reports ${known.label} (${reported}), but ${net.label} (${net.chain.id}) was chosen`,
    );
  }
}

/** The RPC URL: the given one (a flag or LAB_RPC_URL) or the testnet's public default. Must be http or https. */
export function chooseRpcUrl(net: Testnet, given: string | undefined): string {
  const url = given || net.env.defaultRpcUrl;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error('the RPC URL is not a valid URL');
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('the RPC URL must be an http or https URL');
  }
  return url;
}

export const SAVED_FILE = '.lab/testnet.env';
const SAVED_VARIABLE = 'LAB_PRIVATE_KEY';

/** Writes the secret to a file only its owner can read, in a directory only its owner can enter. */
export function saveSecret(file: string, secret: Hex): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${SAVED_VARIABLE}=${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The saved secret, or undefined when there is no file. Refuses a file that group or others can read. */
export function readSavedSecret(file: string): Hex | undefined {
  if (!existsSync(file)) return undefined;
  if ((statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} can be read by others: run chmod 600 on it, or delete it`);
  }
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${SAVED_VARIABLE}=`));
  const value = line?.slice(SAVED_VARIABLE.length + 1).trim() ?? '';
  if (!isSecretKey(value)) {
    throw new Error(`${file} has no ${SAVED_VARIABLE}= line with 0x and 64 hex digits`);
  }
  return value;
}

export interface TestnetOptions {
  chain: string | undefined;
  scenarios: readonly string[];
  rpc: string | undefined;
  save: boolean;
  yes: boolean;
}

/** What the command needs from the outside: everything that touches the network, a terminal or the disk. */
export interface TestnetDeps {
  env: Readonly<Record<string, string | undefined>>;
  savedFile: string;
  chainId(rpcUrl: string): Promise<number>;
  balance(rpcUrl: string, address: Address): Promise<bigint>;
  /** Asks for the secret without echoing it. */
  promptSecret(): Promise<string>;
  confirm(question: string): Promise<boolean>;
  log(line: string): void;
}

export interface TestnetPlan {
  net: Testnet;
  rpcUrl: string;
  /** Undefined when no chosen scenario sends anything. */
  secret: Hex | undefined;
  /** The account and its balance before the run, for what the run cost. Undefined when nothing is sent. */
  account?: { address: Address; balance: bigint };
  scenarios: string[];
}

/** What a run cost: the balance before and after. A balance that grew (a faucet drip meanwhile) shows as no cost. */
export function spentLine(
  before: bigint,
  after: bigint,
  estimate: bigint,
  measured: boolean,
): string {
  const spent = before > after ? before - after : 0n;
  const basis = measured ? 'measured' : 'estimate';
  return `spent:     ${eth(spent)} (balance now ${eth(after)}; the cost shown before was ${eth(estimate)}, ${basis})`;
}

const eth = (value: bigint) => `${formatEther(value)} ETH`;

/**
 * Everything before the first transaction: account, RPC, chain check, balance and cost, the list of scenarios, the
 * confirmation. Returns the plan to run, or undefined when the user declined. Throws an Error whose message never
 * contains the secret.
 */
export async function prepareTestnetRun(
  options: TestnetOptions,
  deps: TestnetDeps,
): Promise<TestnetPlan | undefined> {
  const net = testnet(options.chain);
  const rpcUrl = chooseRpcUrl(net, options.rpc ?? deps.env.LAB_RPC_URL);
  checkRpcChain(net, await deps.chainId(rpcUrl));

  const eligibility = chooseScenarios(net, options.scenarios, deps.env);
  for (const { name, reason } of eligibility.skipped) deps.log(`skip ${name}: ${reason}`);
  if (eligibility.run.length === 0) throw new Error('no scenario can run with what was given');
  const senders = eligibility.run.filter((name) => TESTNET_SCENARIOS[name]?.sends).length;

  let secret: Hex | undefined;
  let account: { address: Address; balance: bigint } | undefined;
  if (senders > 0) {
    const given =
      deps.env.LAB_PRIVATE_KEY ||
      readSavedSecret(deps.savedFile) ||
      (await deps.promptSecret()).trim();
    if (!isSecretKey(given)) throw new Error('the key must be 0x followed by 64 hex characters');
    secret = given;
  }

  deps.log(`chain:     ${net.label} (${net.chain.id}), the RPC answers with the same id`);
  deps.log(`scenarios: ${eligibility.run.join(', ')}`);
  if (secret) {
    const address = privateKeyToAccount(secret).address;
    const balance = await deps.balance(rpcUrl, address);
    account = { address, balance };
    const cost = net.runCostWei * BigInt(senders);
    const basis = net.measured ? 'measured' : 'estimate';
    deps.log(`account:   ${address} (shown here only)`);
    deps.log(`balance:   ${eth(balance)}`);
    deps.log(`cost:      about ${eth(cost)} (${senders} sending scenario(s), ${basis})`);
    if (balance < cost) {
      throw new Error(
        `the balance is below the cost of this run: fund the account from a ${net.label} faucet`,
      );
    }
  }
  if (!options.yes && !(await deps.confirm(`Run on ${net.label}? [y/N] `))) return undefined;
  if (secret && options.save) {
    saveSecret(deps.savedFile, secret);
    deps.log(`key saved to ${deps.savedFile} (mode 600, not tracked by git)`);
  }
  return { net, rpcUrl, secret, ...(account ? { account } : {}), scenarios: eligibility.run };
}

/** The environment of one scenario: the testnet's own variables, never the generic LAB_PRIVATE_KEY. */
export function scenarioEnv(
  plan: TestnetPlan,
  base: Readonly<Record<string, string | undefined>>,
  otlp: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && name !== 'LAB_PRIVATE_KEY') env[name] = value;
  }
  env.LAB_TESTNET = plan.net.id;
  env[plan.net.env.rpcUrl] = plan.rpcUrl;
  if (plan.secret) env[plan.net.env.key] = plan.secret;
  env.OTEL_EXPORTER_OTLP_ENDPOINT = otlp;
  return env;
}
