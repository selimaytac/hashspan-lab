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
import { runScenario } from '../src/run.js';

/** Stands for the API key a hosted bundler's URL carries. */
const TOKEN = 'FAKE-TOKEN-1234';

let instance: ReturnType<typeof Instance.anvil>;
let bundler: LocalBundler;
let rpcUrl: string;

// A local chain that reports Base Sepolia's chain id, a stand-in EntryPoint and smart account, and a local bundler:
// tests never leave localhost.
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
  });
  await instance.start();
  await installLocalSmartAccount(createPublicClient({ transport: http(rpcUrl) }) as never);
  bundler = await startLocalBundler({
    rpcUrl,
    executor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    token: TOKEN,
  });
});
afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});
afterAll(async () => {
  await bundler.close();
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

describe('the user operations scenario on a local chain', () => {
  it('records the operation and tops up the smart account first, without the bundler URL anywhere', async () => {
    const { telemetry, captured } = capturingTelemetry();
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlerUrl: bundler.url,
      smartAccount: localSmartAccount,
      topUpConfirmations: 1,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The smart account starts without ether, so the first run tops it up.
    expect(summary.setupTxHashes).toHaveLength(1);
    expect(captured.length).toBeGreaterThan(0);
    const attributes = JSON.stringify(
      captured.map((span) => [span.name, span.attributes, span.events]),
    );
    expect(attributes).not.toContain(TOKEN);
    expect(attributes).not.toContain(bundler.url);
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });

  it('keeps the bundler URL out of the error when the bundler cannot be reached', async () => {
    const summary = await runScenario(capturingTelemetry().telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlerUrl: `http://127.0.0.1:1/rpc/v1/base-sepolia/${TOKEN}`,
      smartAccount: localSmartAccount,
      topUpConfirmations: 1,
      pollingInterval: 100,
    });

    expect(summary.outcome).toBe('error');
    expect(summary.errorKind).toBe('unexpected');
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });

  it('stops with a setup error when the lab account cannot top up the smart account', async () => {
    const client = createPublicClient({ transport: http(rpcUrl) });
    await client.request({
      method: 'anvil_setBalance' as never,
      params: [LOCAL_SMART_ACCOUNT, '0x0'] as never,
    });
    const summary = await runScenario(capturingTelemetry().telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      bundlerUrl: bundler.url,
      smartAccount: localSmartAccount,
      topUpConfirmations: 1,
    });

    expect(summary.outcome).toBe('error');
    expect(summary.errorKind).toBe('setup');
    expect(summary.findings).toEqual([]);
  });
});
