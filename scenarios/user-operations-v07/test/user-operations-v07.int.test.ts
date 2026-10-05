import {
  freePort,
  installLocalSmartAccount,
  LOCAL_SMART_ACCOUNT,
  type LocalBundler,
  localSmartAccount,
  startLocalBundler,
  startTelemetry,
} from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundlerNames, hostedBundler } from '../src/bundlers.js';
import { stepName } from '../src/expectations.js';
import { runScenario } from '../src/run.js';

/** Stand for the API keys hosted bundlers' URLs carry. */
const TOKENS = ['FAKE-TOKEN-ONE-1234', 'FAKE-TOKEN-TWO-5678'];

let instance: ReturnType<typeof Instance.anvil>;
let bundlers: LocalBundler[];
let rpcUrl: string;

// A local chain that reports Base Sepolia's chain id, the stand-in EntryPoint v0.7 and test account, and two local
// bundlers: tests never leave localhost.
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
  });
  await instance.start();
  await installLocalSmartAccount(createPublicClient({ transport: http(rpcUrl) }));
  const executor = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  bundlers = await Promise.all(
    TOKENS.map((token) => startLocalBundler({ rpcUrl, executor, token })),
  );
});
afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});
afterAll(async () => {
  await Promise.all(bundlers.map((bundler) => bundler.close()));
  await instance.stop();
});

/** Telemetry that also hands the run's spans to the test. */
function capturingTelemetry() {
  const telemetry = startTelemetry({
    serviceName: 'test',
    otlp: { traces: false, metrics: false },
  });
  const captured: ReadableSpan[] = [];
  const finish = telemetry.finish.bind(telemetry);
  telemetry.finish = async (flush) => {
    const result = await finish(flush);
    captured.push(...result.spans);
    return result;
  };
  return { telemetry, captured };
}

const fundedKey = async () => {
  const privateKey = generatePrivateKey();
  await createPublicClient({ transport: http(rpcUrl) }).request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
  });
  return privateKey;
};

const localBundlers = () =>
  bundlers.map((bundler, index) => ({
    name: index === 0 ? 'pimlico' : 'candide',
    url: bundler.url,
  }));

describe('the EntryPoint v0.7 user operations scenario on a local chain', () => {
  it('records one operation per bundler under its step, without a bundler URL anywhere', async () => {
    const { telemetry, captured } = capturingTelemetry();
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlers: localBundlers,
      smartAccount: localSmartAccount,
      confirmations: 1,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.userOperations.map(({ bundler }) => bundler)).toEqual(['pimlico', 'candide']);
    for (const { userOpHash } of summary.userOperations)
      expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(summary.userOperations.map(({ userOpHash }) => userOpHash)).size).toBe(2);
    // The smart account starts without ether, so the first run tops it up once, for both operations.
    expect(summary.setupTxHashes).toHaveLength(1);
    expect(captured.filter((span) => span.name === stepName('candide'))).toHaveLength(1);
    const recorded = JSON.stringify([
      captured.map((span) => [span.name, span.attributes, span.events]),
      summary,
    ]);
    for (const token of TOKENS) expect(recorded).not.toContain(token);
    for (const { url } of bundlers) expect(recorded).not.toContain(url);
  });

  it('keeps the bundler URL out of the error when the second bundler cannot be reached', async () => {
    const summary = await runScenario(capturingTelemetry().telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlers: () => [
        ...localBundlers().slice(0, 1),
        { name: 'candide', url: `http://127.0.0.1:1/public/v3/84532/${TOKENS[1]}` },
      ],
      smartAccount: localSmartAccount,
      confirmations: 1,
      pollingInterval: 100,
    });

    expect(summary.outcome).toBe('error');
    expect(summary.errorKind).toBe('unexpected');
    expect(summary.userOperations.map(({ bundler }) => bundler)).toEqual(['pimlico']);
    expect(JSON.stringify(summary)).not.toContain(TOKENS[1]);
  });

  it('stops with a setup error for an unknown bundler name or when the lab account cannot top up', async () => {
    const unknown = await runScenario(capturingTelemetry().telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlers: () => bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: 'alchemy' }).map(hostedBundler),
      smartAccount: localSmartAccount,
      confirmations: 1,
    });
    expect(unknown.outcome).toBe('error');
    expect(unknown.errorKind).toBe('setup');
    expect(unknown.userOperations).toEqual([]);

    await createPublicClient({ transport: http(rpcUrl) }).request({
      method: 'anvil_setBalance' as never,
      params: [LOCAL_SMART_ACCOUNT, '0x0'] as never,
    });
    const poor = await runScenario(capturingTelemetry().telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlers: localBundlers,
      smartAccount: localSmartAccount,
      confirmations: 1,
    });
    expect(poor.outcome).toBe('error');
    expect(poor.errorKind).toBe('setup');
    expect(poor.findings).toEqual([]);
  });
});
