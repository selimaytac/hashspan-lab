import { startTelemetry, testnet } from '@hashspan-lab/common';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

// A local chain with Base Sepolia's chain id, mining a block every second so confirmations overlap as on a testnet.
const PORT = 18650;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 84532,
  blockTime: 1,
});

beforeAll(async () => {
  await instance.start();
});
afterAll(async () => {
  await instance.stop();
});

describe('runScenario', () => {
  it('confirms, links and counts every one of many transactions', async () => {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    await createPublicClient({ transport: http(RPC_URL) }).request({
      method: 'anvil_setBalance' as never,
      params: [address, numberToHex(parseEther('1'))] as never,
    });
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startTelemetry({
      serviceName: 'soak-agent',
      otlp: { traces: false, metrics: false },
      metricReaders: [
        new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 3_600_000 }),
      ],
    });
    const summary = await runScenario(telemetry, {
      net: testnet('base-sepolia'),
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
      log: () => {},
      transactions: 10,
      metrics,
      opStack: false,
      pollingInterval: 200,
    });
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.transactions).toBe(10);
    expect(summary.confirmMs.p95).not.toBeNull();
    expect(BigInt(summary.feeWei)).toBeGreaterThan(0n);
    expect(JSON.stringify(summary).toLowerCase()).not.toContain(address.slice(2).toLowerCase());
  }, 120_000);
});
