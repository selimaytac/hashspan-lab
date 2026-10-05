import { createServer } from 'node:net';
import { startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REVERTS } from '../src/contracts.js';
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

describe('the paths scenario on a local chain', () => {
  it('records every path: background confirmation, watch(), JSON-RPC spans and three revert reasons', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey('1'), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      opStack: false,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.setupTxHashes).toHaveLength(REVERTS.length);
    expect(summary.transactions.map((tx) => [tx.tool, tx.status]).sort()).toEqual(
      [
        ['background', 'success'],
        ['watch', 'success'],
        ...REVERTS.map(({ step }) => [step, 'reverted']),
      ].sort(),
    );
  });

  it('stops before sending when the balance does not cover the run', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      env: { BASE_SEPOLIA_PRIVATE_KEY: await fundedKey('0.0000001'), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      opStack: false,
      pollingInterval: 100,
    });
    expect(summary.outcome).toBe('error');
    expect(summary.setupTxHashes).toEqual([]);
  });
});
