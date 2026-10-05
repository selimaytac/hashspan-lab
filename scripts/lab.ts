// One command for the whole local lab: `pnpm lab up` (alias `make demo`). Node built-ins only.
// See scripts/lab/commands.ts for the commands; the checks before `up` are in scripts/lab/preflight.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, http } from 'viem';
import { grafanaLinks, LOCAL_SCENARIOS, parseCommand, USAGE } from './lab/commands.js';
import { connectOutput } from './lab/connect.js';
import { firstRun } from './lab/first-run-run.js';
import {
  type Check,
  diskCheck,
  dockerCheck,
  formatChecks,
  nodeCheck,
  PORTS,
  pnpmCheck,
  portsCheck,
} from './lab/preflight.js';
import {
  prepareTestnetRun,
  SAVED_FILE,
  scenarioEnv,
  scrub,
  type TestnetDeps,
} from './lab/testnet.js';

const root = resolve(import.meta.dirname, '..');
const COMPOSE = ['compose', '-f', 'stack/compose.yaml'];
const OTLP = 'http://127.0.0.1:14318';
const GRAFANA = 'http://127.0.0.1:13000';
const PROMETHEUS = 'http://127.0.0.1:19090';
const TEMPO = 'http://127.0.0.1:13200';

function run(command: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Runs a step that prints its own output; returns whether it succeeded. */
function step(title: string, command: string, args: string[]): boolean {
  console.log(`\n== ${title}`);
  return spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status === 0;
}

function tail(text: string, lines = 15): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

const stackRunning = (): boolean => run('docker', [...COMPOSE, 'ps', '-q']).stdout.trim() !== '';

async function preflight(): Promise<boolean> {
  const checks: Check[] = [
    nodeCheck(readFileSync(resolve(root, '.nvmrc'), 'utf8'), process.version),
    pnpmCheck(run('pnpm', ['--version']).status),
    dockerCheck(run('docker', ['info']).status),
    diskCheck(statfsSync(root).bavail * statfsSync(root).bsize),
  ];
  // A running stack of this lab holds the ports itself: `up` is meant to be run again.
  checks.push(
    stackRunning()
      ? { name: 'Ports', ok: true, detail: 'the stack of this lab is already running' }
      : await portsCheck(PORTS),
  );
  console.log(formatChecks(checks));
  return checks.every((check) => check.ok);
}

const SERVICES: { name: string; ready: () => Promise<boolean> }[] = [
  { name: 'grafana', ready: () => ok(`${GRAFANA}/api/health`) },
  { name: 'prometheus', ready: () => ok(`${PROMETHEUS}/-/ready`) },
  { name: 'tempo', ready: () => ok(`${TEMPO}/ready`) },
  {
    name: 'collector',
    ready: () =>
      ok(`${OTLP}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
  },
];

async function ok(url: string, init?: RequestInit): Promise<boolean> {
  try {
    return (await fetch(url, { ...init, signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let pending = SERVICES.map((service) => service.name);
  while (Date.now() < deadline) {
    const states = await Promise.all(SERVICES.map(async (s) => [s.name, await s.ready()] as const));
    pending = states.filter(([, ready]) => !ready).map(([name]) => name);
    if (pending.length === 0) return true;
    await sleep(2000);
  }
  console.error(`not ready after ${timeoutMs / 1000}s: ${pending.join(', ')}`);
  console.error(`see why with: docker compose -f stack/compose.yaml logs ${pending.join(' ')}`);
  return false;
}

function ensureAnvil(): boolean {
  return (
    existsSync(resolve(root, '.tools/bin/anvil')) ||
    step('Install Anvil', './scripts/install-anvil.sh', [])
  );
}

function scenario(name: string) {
  return run('pnpm', ['--filter', `./scenarios/${name}`, 'start:local'], {
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP,
  });
}

async function checkDashboards(): Promise<boolean> {
  // Prometheus and Tempo take a moment to show what the last scenario sent: look again for about a minute.
  let output = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = run('node', ['scripts/check-dashboards.mjs', '--since', '3600', '--strict']);
    output = result.stdout + result.stderr;
    if (result.status === 0) {
      console.log(
        output
          .trim()
          .split('\n')
          .filter((l) => !l.startsWith('  '))
          .join('\n'),
      );
      return true;
    }
    if (attempt < 6) await sleep(10_000);
  }
  console.error(
    output
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('  ') || /ERROR|EMPTY/.test(l))
      .join('\n'),
  );
  console.error(
    'a panel is empty or its query fails; the scenario output above says which one did not run',
  );
  return false;
}

function dashboardFiles(): { uid: string; title: string }[] {
  const dir = resolve(root, 'dashboards');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as { uid: string; title: string },
    );
}

async function printLinks(): Promise<void> {
  let traceId: string | undefined;
  try {
    const url = `${TEMPO}/api/search?q=${encodeURIComponent('{ name =~ "send.*" }')}&limit=1`;
    const body = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json()) as {
      traces?: { traceID: string }[];
    };
    traceId = body.traces?.[0]?.traceID;
  } catch {
    // The links of the dashboards are enough.
  }
  const links = grafanaLinks(dashboardFiles(), traceId);
  console.log('\nDashboards (no login needed):');
  for (const link of links.dashboards) console.log(`  ${link.title}: ${link.url}`);
  if (links.traceJson) console.log(`An example trace as JSON (no login):\n  ${links.traceJson}`);
  if (links.trace)
    console.log(
      `The same trace in Grafana Explore (log in as admin / admin first):\n  ${links.trace}`,
    );
}

async function up(skipInstall: boolean): Promise<number> {
  const started = Date.now();
  console.log('== Checking this machine');
  if (!(await preflight())) return 1;
  if (!skipInstall && !step('Install dependencies', 'pnpm', ['install', '--frozen-lockfile']))
    return 1;
  if (!ensureAnvil()) return 1;
  if (!step('Start the stack', 'docker', [...COMPOSE, 'up', '-d', '--remove-orphans'])) {
    console.error(
      'docker could not start the stack: is the daemon running, and can it pull images?',
    );
    return 1;
  }
  console.log('\n== Waiting for the stack');
  if (!(await waitHealthy())) return 1;

  console.log('\n== Scenarios on a local chain');
  const failed: string[] = [];
  for (const name of LOCAL_SCENARIOS) {
    const began = Date.now();
    const result = scenario(name);
    const seconds = Math.round((Date.now() - began) / 1000);
    if (result.status === 0) {
      console.log(`ok   ${name} (${seconds}s)`);
    } else {
      failed.push(name);
      console.log(
        `FAIL ${name} (${seconds}s); last output:\n${tail(result.stdout + result.stderr)}`,
      );
      console.log(`     -> run it alone with: pnpm lab run ${name}`);
    }
  }

  console.log('\n== Dashboards');
  const dashboardsOk = await checkDashboards();
  await printLinks();
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `\n${failed.length === 0 && dashboardsOk ? 'Lab is up' : 'Lab is up with problems'} (${minutes} min)`,
  );
  console.log('Stop it with `pnpm lab down`, remove everything with `pnpm lab nuke`.');
  return failed.length === 0 && dashboardsOk ? 0 : 1;
}

/** Reads a line from the terminal without echoing it. */
async function promptSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'no terminal to ask for the key: set LAB_PRIVATE_KEY, or run this in a terminal',
    );
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write('Testnet private key (hidden input): ');
    muted = true;
    return await rl.question('');
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    throw new Error('no terminal to ask on: pass --yes to confirm in advance');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

// Errors of these two calls are replaced by fixed texts: the RPC URL may carry the user's own API key.
async function rpcChainId(rpcUrl: string): Promise<number> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { result?: string };
    const id = Number(body.result);
    if (!Number.isInteger(id)) throw new Error('no chain id');
    return id;
  } catch {
    throw new Error('the RPC did not answer eth_chainId; check the URL and your network');
  }
}

async function rpcBalance(rpcUrl: string, address: `0x${string}`): Promise<bigint> {
  try {
    return await createPublicClient({ transport: http(rpcUrl) }).getBalance({ address });
  } catch {
    throw new Error('the RPC did not answer the balance request');
  }
}

async function testnetCommand(
  command: Extract<ReturnType<typeof parseCommand>, { name: 'testnet' }>,
): Promise<number> {
  const deps: TestnetDeps = {
    env: process.env,
    savedFile: resolve(root, SAVED_FILE),
    chainId: rpcChainId,
    balance: rpcBalance,
    promptSecret,
    confirm,
    log: (line) => console.log(line),
  };
  let plan: Awaited<ReturnType<typeof prepareTestnetRun>>;
  try {
    plan = await prepareTestnetRun(command, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!plan) {
    console.log('Nothing was sent.');
    return 0;
  }
  const collector = SERVICES.find((service) => service.name === 'collector');
  if (!(await collector?.ready())) {
    console.error(
      'the stack is not up, so the telemetry would go nowhere: run `pnpm lab up` (or `make lab-up`) first',
    );
    return 1;
  }
  const secrets = [plan.secret ?? '', plan.rpcUrl];
  const failed: string[] = [];
  for (const name of plan.scenarios) {
    const began = Date.now();
    const result = run(
      'pnpm',
      ['--filter', `./scenarios/${name}`, 'start'],
      scenarioEnv(plan, process.env, OTLP),
    );
    const seconds = Math.round((Date.now() - began) / 1000);
    const text = scrub(result.stdout + result.stderr, secrets);
    if (result.status === 0) {
      console.log(`ok   ${name} (${seconds}s)\n${tail(text, 1)}`);
    } else {
      failed.push(name);
      console.log(`FAIL ${name} (${seconds}s); last output:\n${tail(text)}`);
    }
  }
  await printLinks();
  return failed.length === 0 ? 0 : 1;
}

async function status(): Promise<number> {
  step('Containers', 'docker', [...COMPOSE, 'ps']);
  console.log('\nServices:');
  for (const service of SERVICES)
    console.log(`  ${service.name}: ${(await service.ready()) ? 'ready' : 'not ready'}`);
  await printLinks();
  return 0;
}

async function main(): Promise<number> {
  let command: ReturnType<typeof parseCommand>;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  switch (command.name) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'up':
      return up(command.skipInstall);
    case 'down':
      return step('Stop the stack', 'docker', [...COMPOSE, 'stop']) ? 0 : 1;
    case 'nuke': {
      const done = step('Remove containers, volumes and images', 'docker', [
        ...COMPOSE,
        'down',
        '-v',
        '--rmi',
        'all',
        '--remove-orphans',
      ]);
      rmSync(resolve(root, '.tools'), { recursive: true, force: true });
      console.log('removed .tools');
      return done ? 0 : 1;
    }
    case 'run':
      if (!ensureAnvil()) return 1;
      return step(`Scenario ${command.scenario}`, 'pnpm', [
        '--filter',
        `./scenarios/${command.scenario}`,
        'start:local',
      ])
        ? 0
        : 1;
    case 'status':
      return status();
    case 'testnet':
      return testnetCommand(command);
    case 'first-run':
      try {
        return await firstRun({ version: command.version, root });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'connect': {
      const collector = SERVICES.find((service) => service.name === 'collector');
      console.log(connectOutput((await collector?.ready()) ?? false));
      return 0;
    }
  }
}

process.exitCode = await main();
