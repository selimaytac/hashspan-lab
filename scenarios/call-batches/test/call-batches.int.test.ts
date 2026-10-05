import { freePort, startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

let instance: ReturnType<typeof Instance.anvil>;
let rpcUrl: string;

// A local chain that reports Base Sepolia's chain id stands in for the testnet: tests never leave localhost.
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
  });
  await instance.start();
});
afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});
afterAll(async () => {
  await instance.stop();
});

describe('the call batches scenario on a local chain', () => {
  it('records both batches, their outcomes and the confirm spans of the fallback transactions', async () => {
    const privateKey = generatePrivateKey();
    await createPublicClient({ transport: http(rpcUrl) }).request({
      method: 'anvil_setBalance' as never,
      params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
    });
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      opStack: false,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    // Anvil answers wallet_sendCalls with -32601, which viem takes as a reason to fall back.
    expect(summary.publicRpcFallback).toBe('falls back');
  });
});
