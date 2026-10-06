import { parseArgs } from 'node:util';
import { DEFAULT_TESTNET_SCENARIOS } from './testnet.js';

/** The scenarios `up` runs on the local chain, in order. `sealed-fees` needs a public RPC; `soak` is a long run. */
export const LOCAL_SCENARIOS = [
  'treasury',
  'paths',
  'replacement',
  'call-batches',
  'user-operations',
  'user-operations-v07',
  'eip7702',
  'x402',
  'cdp',
] as const;

export const USAGE = `usage: pnpm lab <command>

  up [--skip-install]   check the machine, start the stack, run every local scenario, check the dashboards
  down                  stop the stack, keep its data
  nuke                  remove containers, volumes, images and .tools
  run <scenario>        run one scenario on the local chain, telemetry to the stack
  testnet [--chain <name>] [--scenario <name,...|all>] [--rpc <url>] [--save] [--yes]
                        run scenarios on a real testnet with your own key (the stack must be up)
  status                show the containers, the ports and the links
  first-run [--version <v>]
                        what a new user does: the README quick start of the published @hashspan/viem (default tag rc)
  conformance [--since <s>]
                        check the telemetry the stack received against the semantic conventions of @hashspan/core
  connect               print the environment variables that point your own agent at the lab's collector

scenarios: ${LOCAL_SCENARIOS.join(', ')}
testnet chains: base-sepolia (default), sepolia, arbitrum-sepolia, op-sepolia; testnet scenario default: treasury`;

export type Command =
  | { name: 'up'; skipInstall: boolean }
  | { name: 'down' | 'nuke' | 'status' | 'connect' | 'help' }
  | { name: 'first-run'; version: string }
  | { name: 'conformance'; since: string }
  | { name: 'run'; scenario: string }
  | {
      name: 'testnet';
      chain: string | undefined;
      scenarios: string[];
      rpc: string | undefined;
      save: boolean;
      yes: boolean;
    };

/** Parses `argv` (without node and the script). Throws an Error with a message for the user on bad input. */
export function parseCommand(argv: readonly string[]): Command {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'skip-install': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      chain: { type: 'string' },
      scenario: { type: 'string', multiple: true },
      rpc: { type: 'string' },
      save: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      version: { type: 'string' },
      since: { type: 'string' },
    },
  });
  const [name, ...rest] = positionals;
  if (values.help || name === undefined || name === 'help') return { name: 'help' };
  if (name !== 'conformance' && values.since !== undefined) {
    throw new Error('--since belongs to the conformance command');
  }
  if (name === 'conformance') {
    if (rest.length > 0) throw new Error(`conformance takes no argument, got: ${rest.join(' ')}`);
    return { name: 'conformance', since: values.since ?? '3600' };
  }
  if (name !== 'first-run' && values.version !== undefined) {
    throw new Error('--version belongs to the first-run command');
  }
  if (name === 'first-run') {
    if (rest.length > 0) throw new Error(`first-run takes no argument, got: ${rest.join(' ')}`);
    return { name: 'first-run', version: values.version ?? 'rc' };
  }
  if (name !== 'testnet') {
    for (const flag of ['chain', 'scenario', 'rpc', 'save', 'yes'] as const) {
      if (values[flag] !== undefined && values[flag] !== false) {
        throw new Error(`--${flag} belongs to the testnet command`);
      }
    }
  }
  if (name === 'testnet') {
    if (rest.length > 0) throw new Error(`testnet takes no argument, got: ${rest.join(' ')}`);
    if (values['skip-install']) throw new Error('--skip-install belongs to the up command');
    const scenarios = (values.scenario ?? []).flatMap((entry) => entry.split(',')).filter(Boolean);
    return {
      name: 'testnet',
      chain: values.chain,
      scenarios: scenarios.length > 0 ? scenarios : [...DEFAULT_TESTNET_SCENARIOS],
      rpc: values.rpc,
      save: values.save,
      yes: values.yes,
    };
  }
  if (name === 'up') {
    if (rest.length > 0) throw new Error(`up takes no argument, got: ${rest.join(' ')}`);
    return { name: 'up', skipInstall: values['skip-install'] };
  }
  if (name === 'down' || name === 'nuke' || name === 'status' || name === 'connect') {
    if (rest.length > 0) throw new Error(`${name} takes no argument, got: ${rest.join(' ')}`);
    return { name };
  }
  if (name === 'run') {
    const [scenario, ...extra] = rest;
    if (!scenario || extra.length > 0) throw new Error('run takes one scenario name');
    if (!(LOCAL_SCENARIOS as readonly string[]).includes(scenario)) {
      throw new Error(`unknown scenario ${scenario}; one of: ${LOCAL_SCENARIOS.join(', ')}`);
    }
    return { name: 'run', scenario };
  }
  throw new Error(`unknown command ${name}\n${USAGE}`);
}

export interface Links {
  dashboards: { title: string; url: string }[];
  /** Grafana's explorer: opens only after a login (admin / admin on first start), anonymous viewers cannot use it. */
  trace?: string;
  /** The trace as JSON from Tempo's API: needs no login. */
  traceJson?: string;
}

/** Grafana links: one per dashboard (uid and title from its JSON) and one to a trace in Tempo's explorer. */
export function grafanaLinks(
  dashboards: readonly { uid: string; title: string }[],
  traceId?: string,
  base = 'http://127.0.0.1:13000',
  tempo = 'http://127.0.0.1:13200',
): Links {
  const links: Links = {
    dashboards: dashboards.map((d) => ({ title: d.title, url: `${base}/d/${d.uid}` })),
  };
  if (traceId) {
    const pane = {
      a: {
        datasource: 'tempo',
        queries: [
          {
            refId: 'A',
            datasource: { type: 'tempo', uid: 'tempo' },
            queryType: 'traceql',
            query: traceId,
          },
        ],
      },
    };
    links.traceJson = `${tempo}/api/traces/${traceId}`;
    links.trace = `${base}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(pane))}`;
  }
  return links;
}
