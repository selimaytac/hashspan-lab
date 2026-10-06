import { createServer } from 'node:net';
import { startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
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

/** A fresh account holding `eth`, so no key is ever written down. */
async function fundedKey(eth: string) {
  const privateKey = generatePrivateKey();
  await createPublicClient({ transport: http(rpcUrl) }).request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther(eth))] as never,
  });
  return privateKey;
}

describe('the replacement scenario on a local chain', () => {
  it('records a repriced, a cancelled and a replaced transaction, each with the receipt of its replacement', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey('1'), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.transactions.map((tx) => [tx.tool, tx.status, tx.reason]).sort()).toEqual(
      [
        ['repriced', 'replaced', 'repriced'],
        ['repriced', 'success', null],
        ['cancelled', 'replaced', 'cancelled'],
        ['cancelled', 'success', null],
        ['replaced', 'replaced', 'replaced'],
        ['replaced', 'success', null],
      ].sort(),
    );
    // Each replaced span names the hash of the mined one.
    for (const replaced of summary.transactions.filter((tx) => tx.status === 'replaced')) {
      expect(
        summary.transactions.some(
          (tx) => tx.hash === replaced.replacementHash && tx.status === 'success',
        ),
      ).toBe(true);
    }
  });

  it('stops with an error on a chain that is not Base Sepolia', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const other = Instance.anvil({
      binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
      port: await freePort(),
      chainId: 1,
    });
    await other.start();
    try {
      const url = `http://127.0.0.1:${other.port}`;
      const summary = await runScenario(telemetry, {
        env: { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: url },
        log: () => {},
      });
      expect(summary.outcome).toBe('error');
      expect(summary.error).toContain('chain id 1');
    } finally {
      await other.stop();
    }
  });
});
