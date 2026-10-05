import { OpenTelemetry } from '@ai-sdk/otel';
import { startTelemetry, testnet } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { registerTelemetry } from 'ai';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

// A local chain that reports Base Sepolia's chain id stands in for the testnet: tests never leave localhost.
const PORT = 18647;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 84532,
});
const rpc = createPublicClient({ transport: http(RPC_URL) });
const BASE = testnet('base-sepolia');
const noOtlp = { traces: false, metrics: false };

/** A fresh account holding `eth`, so no key is ever written down. */
async function fundedKey(eth: string) {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  await rpc.request({
    method: 'anvil_setBalance' as never,
    params: [address, numberToHex(parseEther(eth))] as never,
  });
  return { privateKey, address };
}

beforeAll(async () => {
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

describe('runScenario', () => {
  it('passes its span check, records the three histograms and summarizes without secrets', async () => {
    const { privateKey, address } = await fundedKey('0.01');
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startTelemetry({
      serviceName: 'treasury-agent',
      otlp: noOtlp,
      metricReaders: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
    });
    registerTelemetry(new OpenTelemetry());
    const lines: string[] = [];

    const summary = await runScenario(telemetry, {
      net: BASE,
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
      log: (line) => lines.push(line),
      opStack: false,
      pollingInterval: 100,
    });

    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.transactions.map((tx) => [tx.tool, tx.status])).toEqual([
      ['pay_vendor', 'success'],
      ['withdraw_from_vault', 'reverted'],
    ]);
    expect(BigInt(summary.feeWei)).toBeGreaterThan(0n);
    expect(summary.setupTxHashes).toHaveLength(1);
    const printed = `${lines.join('\n')}\n${JSON.stringify(summary)}`;
    expect(printed).not.toContain(privateKey.slice(2));
    expect(JSON.stringify(summary)).not.toContain(RPC_URL);
    expect(JSON.stringify(summary).toLowerCase()).not.toContain(address.slice(2).toLowerCase());

    const names = new Set(
      metricExporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name))),
    );
    expect([...names].sort()).toEqual([
      'blockchain.client.confirmation.duration',
      'blockchain.client.fee',
      'blockchain.client.send.duration',
    ]);
  });

  it('ends with an error, sending nothing, when the balance does not cover the run', async () => {
    const { privateKey, address } = await fundedKey('0.000001');
    const telemetry = startTelemetry({ serviceName: 'treasury-agent', otlp: noOtlp });
    const summary = await runScenario(telemetry, {
      net: BASE,
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: RPC_URL },
      log: () => {},
      opStack: false,
    });
    expect(summary.outcome).toBe('error');
    expect(summary.error).toContain('fund it from a Base Sepolia faucet');
    expect(summary.transactions).toEqual([]);
    expect(await rpc.getTransactionCount({ address })).toBe(0);
  });

  it('ends with an error when the key is missing, without touching the chain', async () => {
    const telemetry = startTelemetry({ serviceName: 'treasury-agent', otlp: noOtlp });
    const summary = await runScenario(telemetry, {
      net: BASE,
      env: {},
      log: () => {},
      opStack: false,
    });
    expect(summary.outcome).toBe('error');
    expect(summary.error).toBe('BASE_SEPOLIA_PRIVATE_KEY is not set.');
  });
});
