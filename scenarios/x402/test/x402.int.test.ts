import { freePort, startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ANVIL_SETTLER, deployTestUsd } from '../src/local-chain.js';
import { localFacilitator } from '../src/local-facilitator.js';
import { NETWORK, PRICE, runScenario } from '../src/run.js';

let instance: ReturnType<typeof Instance.anvil>;
let rpcUrl: string;

// A local chain that reports Base Sepolia's chain id stands in for the testnet, with a local token and the SDK's
// facilitator in this process: tests never leave localhost.
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

const telemetry = () =>
  startTelemetry({ serviceName: 'test', otlp: { traces: false, metrics: false } });

describe('the x402 scenario on a local chain', () => {
  it('records a settled, verified payment and the linked confirm span of the settlement', async () => {
    const privateKey = generatePrivateKey();
    const asset = await deployTestUsd(rpcUrl, privateKey, 10n * PRICE);
    const summary = await runScenario(telemetry(), {
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      facilitator: localFacilitator(rpcUrl, ANVIL_SETTLER, NETWORK),
      asset,
      opStack: false,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.settlementTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('stops with a setup error, not a finding, when the account holds too little of the token', async () => {
    const asset = await deployTestUsd(rpcUrl, generatePrivateKey(), PRICE);
    const summary = await runScenario(telemetry(), {
      env: { BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: rpcUrl },
      log: () => {},
      facilitator: localFacilitator(rpcUrl, ANVIL_SETTLER, NETWORK),
      asset,
      opStack: false,
    });

    expect(summary.outcome).toBe('error');
    expect(summary.error).toMatch(/Circle faucet/);
    expect(summary.findings).toEqual([]);
  });
});
