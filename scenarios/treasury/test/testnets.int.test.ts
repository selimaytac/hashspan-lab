import { OpenTelemetry } from '@ai-sdk/otel';
import { startTelemetry, testnet } from '@hashspan-lab/common';
import { registerTelemetry } from 'ai';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario } from '../src/run.js';

// The scenario on a testnet other than Base Sepolia, against a local chain with Ethereum Sepolia's chain id. A file of
// its own: the scenario's withHashspan() is bound to the first telemetry of the process, as in a real run.
const PORT = 18649;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: 11155111,
});
const rpc = createPublicClient({ transport: http(RPC_URL) });
const noOtlp = { traces: false, metrics: false };

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
afterAll(async () => {
  await instance.stop();
});

describe('runScenario on Ethereum Sepolia', () => {
  it('runs with the shared lab key and names its spans by that chain', async () => {
    const { privateKey } = await fundedKey('0.01');
    const telemetry = startTelemetry({ serviceName: 'treasury-agent', otlp: noOtlp });
    registerTelemetry(new OpenTelemetry());
    const lines: string[] = [];
    const summary = await runScenario(telemetry, {
      net: testnet('sepolia'),
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, SEPOLIA_RPC_URL: RPC_URL },
      log: (line) => lines.push(line),
      pollingInterval: 100,
    });
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.chainId).toBe(11155111);
    expect(summary.transactions.map((tx) => tx.status)).toEqual(['success', 'reverted']);
    expect(lines.join('\n')).toContain('https://sepolia.etherscan.io/tx/');
  });

  it('refuses a testnet whose chain id the RPC does not report, sending nothing', async () => {
    const { privateKey, address } = await fundedKey('0.01');
    const telemetry = startTelemetry({ serviceName: 'treasury-agent', otlp: noOtlp });
    const summary = await runScenario(telemetry, {
      net: testnet('arbitrum-sepolia'),
      env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, ARBITRUM_SEPOLIA_RPC_URL: RPC_URL },
      log: () => {},
    });
    expect(summary.outcome).toBe('error');
    expect(summary.errorKind).toBe('setup');
    expect(summary.error).toBe(
      'The RPC reports chain id 11155111; this run only uses Arbitrum Sepolia (421614).',
    );
    expect(await rpc.getTransactionCount({ address })).toBe(0);
  });
});
