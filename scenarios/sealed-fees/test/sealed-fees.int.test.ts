import { createServer } from 'node:net';
import { startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { createPublicClient, createWalletClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

/** A free TCP port on 127.0.0.1, so several checkouts can run the tests at once. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port === undefined ? reject(new Error('no port')) : resolve(port)));
    });
  });
}

let instance: ReturnType<typeof Instance.anvil>;
let rpcUrl: string;

// A local chain that reports Base Sepolia's chain id and mines a block every second, so sent transactions wait in the
// pending block as they do on the testnet: tests never leave localhost.
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
    blockTime: 1,
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

describe('the sealed fees scenario on a local chain', () => {
  it('watches transactions of other accounts and finds their spans carry the sealed fees', async () => {
    const rpc = createPublicClient({ transport: http(rpcUrl) });
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await rpc.request({
      method: 'anvil_setBalance' as never,
      params: [account.address, numberToHex(parseEther('1'))] as never,
    });
    const sender = createWalletClient({ account, transport: http(rpcUrl) });
    // Someone else's traffic, sent in the background while the scenario samples the pending block.
    const traffic = (async () => {
      for (let nonce = 0; nonce < 12; nonce++) {
        await sender.sendTransaction({
          to: account.address,
          value: 1n,
          nonce,
          gas: 21_000n,
          maxFeePerGas: parseEther('0.00000001'),
          maxPriorityFeePerGas: 1n,
          chain: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();

    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      sampleMs: 4_000,
      minChecked: 5,
      pollingInterval: 100,
    });
    await traffic;

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.checked).toBeGreaterThanOrEqual(5);
  });

  it('reports an idle chain as an error, not a finding', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      sampleMs: 1_500,
      minChecked: 5,
      pollingInterval: 100,
    });
    expect(summary.outcome).toBe('error');
    expect(summary.findings).toEqual([]);
  });
});
