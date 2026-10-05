import { startTelemetry, testnet } from '@hashspan-lab/common';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

// A local chain with Base Sepolia's chain id (Anvil runs Prague, so type 4 transactions are accepted).
const PORT = 18651;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 84532,
});

beforeAll(async () => {
  await instance.start();
});
afterAll(async () => {
  await instance.stop();
});

describe('runScenario', () => {
  it('sets and clears a sponsored delegation, traced with its authorization attributes', async () => {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    const rpc = createPublicClient({ transport: http(RPC_URL) });
    await rpc.request({
      method: 'anvil_setBalance' as never,
      params: [address, numberToHex(parseEther('1'))] as never,
    });
    const telemetry = startTelemetry({
      serviceName: 'eip7702-agent',
      otlp: { traces: false, metrics: false },
    });
    const summary = await runScenario(telemetry, {
      net: testnet('base-sepolia'),
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
      log: () => {},
      opStack: false,
      pollingInterval: 100,
    });
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.transactions.map((tx) => tx.tool)).toEqual(['delegate', 'clear']);
    // The sponsor stays a plain account.
    expect(await rpc.getCode({ address })).toBeUndefined();
    expect(JSON.stringify(summary).toLowerCase()).not.toContain(address.slice(2).toLowerCase());
  });
});
