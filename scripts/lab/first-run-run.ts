import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  checkQuickStartTrace,
  extractQuickStart,
  pinHashspan,
  readmeUrl,
  traceSpans,
} from './first-run.js';
import { portFree } from './preflight.js';

const OTLP = 'http://127.0.0.1:14318';
const TEMPO = 'http://127.0.0.1:13200';
const ANVIL_PORT = 8545;
const ANVIL_CHAIN_ID = 31337;

export interface FirstRunOptions {
  /** A version, or a dist-tag such as `rc` or `latest`. */
  version: string;
  root: string;
}

function resolveVersion(version: string): string {
  const result = spawnSync('npm', ['view', `@hashspan/viem@${version}`, 'version', '--json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`@hashspan/viem@${version} is not on the npm registry`);
  const parsed = JSON.parse(result.stdout) as string | string[];
  const resolved = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!resolved) throw new Error(`@hashspan/viem@${version} resolves to nothing`);
  return resolved;
}

async function ok(url: string, init?: RequestInit): Promise<boolean> {
  try {
    return (await fetch(url, { ...init, signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

/** The newest trace of the README's example agent that started at or after `since` (ms), as its spans. */
async function findTrace(since: number): Promise<ReturnType<typeof traceSpans> | undefined> {
  const query = '{ resource.service.name = "my-agent" && name = "pay_vendor" }';
  const url =
    `${TEMPO}/api/search?q=${encodeURIComponent(query)}&limit=20` +
    `&start=${Math.floor(since / 1000) - 10}&end=${Math.floor(Date.now() / 1000) + 60}`;
  try {
    const found = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json()) as {
      traces?: { traceID: string; startTimeUnixNano?: string }[];
    };
    const mine = (found.traces ?? [])
      .filter(
        (trace) => Number(BigInt(trace.startTimeUnixNano ?? '0') / 1_000_000n) >= since - 5000,
      )
      .sort((a, b) =>
        Number(BigInt(b.startTimeUnixNano ?? '0') - BigInt(a.startTimeUnixNano ?? '0')),
      );
    const id = mine[0]?.traceID;
    if (!id) return undefined;
    const trace = await (
      await fetch(`${TEMPO}/api/traces/${id}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    return traceSpans(trace);
  } catch {
    return undefined;
  }
}

/** Runs the quick start of a published release as a new user would. Returns the exit code. */
export async function firstRun({ version, root }: FirstRunOptions): Promise<number> {
  const started = Date.now();
  const resolved = resolveVersion(version);
  console.log(
    `first run of @hashspan/*@${resolved} (asked for ${version}), Node ${process.version}`,
  );

  const response = await fetch(readmeUrl(resolved), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(
      `the README of the tag @hashspan/viem@${resolved} could not be fetched (${response.status})`,
    );
  const quickStart = extractQuickStart(await response.text());

  if (
    !(await ok(`${OTLP}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
  ) {
    throw new Error('the stack is not up: run `pnpm lab up` (or `make lab-up`) first');
  }
  const anvilBinary = resolve(root, '.tools/bin/anvil');
  if (!existsSync(anvilBinary)) throw new Error('no Anvil: run `make tools` first');
  if (!(await portFree(ANVIL_PORT)))
    throw new Error(`port ${ANVIL_PORT} is in use: the quick start's Anvil needs it`);

  const project = mkdtempSync(join(tmpdir(), 'hashspan-first-run-'));
  let anvil: ChildProcess | undefined;
  try {
    // Only what a fresh shell has: no lab key, no CDP secret, no CI token reaches the README's code.
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? project,
      OTEL_EXPORTER_OTLP_ENDPOINT: OTLP,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    };
    const run = (command: string, args: string[], label: string): void => {
      console.log(`$ ${label}`);
      const result = spawnSync(command, args, {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 300_000,
      });
      if (result.status !== 0) {
        const tail = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-15).join('\n');
        throw new Error(`${label} failed:\n${tail}`);
      }
    };

    for (const args of quickStart.installs) {
      const pinned = pinHashspan(args, resolved);
      run('npm', ['install', ...pinned], `npm install ${pinned.join(' ')}`);
    }
    writeFileSync(join(project, 'agent.ts'), quickStart.agent);

    anvil = spawn(anvilBinary, ['--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' });
    const anvilUp = await waitFor(
      () =>
        ok(`http://127.0.0.1:${ANVIL_PORT}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        }),
      20,
    );
    if (!anvilUp) throw new Error('Anvil did not start');

    const ranAt = Date.now();
    for (const args of quickStart.runs) {
      const command = args[0] === 'tsx' ? 'npx' : 'npm';
      run(command, args[0] === 'tsx' ? args : args, `${command} ${args.join(' ')}`);
    }

    const installed = ['core', 'viem']
      .map((name) => {
        const file = join(project, 'node_modules/@hashspan', name, 'package.json');
        return existsSync(file)
          ? `@hashspan/${name}@${(JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version}`
          : `@hashspan/${name} missing`;
      })
      .join(', ');
    console.log(`installed: ${installed}`);

    let spans: ReturnType<typeof traceSpans> | undefined;
    await waitFor(async () => {
      spans = await findTrace(ranAt);
      return spans !== undefined && spans.length >= 3;
    }, 60);
    if (!spans) {
      console.error('FAIL: no trace of the README example in Tempo within 60 s');
      return 1;
    }
    const problems = checkQuickStartTrace(spans, ANVIL_CHAIN_ID);
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    if (problems.length > 0) return 1;
    console.log(
      `ok: pay_vendor with a send and a confirm span under it, in Tempo (${minutes} min)`,
    );
    return 0;
  } finally {
    anvil?.kill();
    rmSync(project, { recursive: true, force: true });
  }
}
