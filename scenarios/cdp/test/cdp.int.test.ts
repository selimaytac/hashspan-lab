import { freePort, startTelemetry } from '@hashspan-lab/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { Instance } from 'prool';
import { type Address, createWalletClient, http } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installLocalSmartAccount,
  type LocalCdpApi,
  startLocalCdpApi,
  throwawayCredentials,
} from '../src/local-cdp-api.js';
import { runScenario } from '../src/run.js';

// Keep the SDK's own usage tracking and error reporting off: tests make no request outside localhost.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';

let instance: ReturnType<typeof Instance.anvil>;
let api: LocalCdpApi;
let rpcUrl: string;
/** Every URL requested through fetch. */
const fetched: string[] = [];

// A local chain that reports Base Sepolia's chain id and a local stand-in for the CDP API: tests never leave
// localhost.
beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    // Blocked rather than passed on, so that a misconfiguration cannot send anything out either.
    if (!url.startsWith('http://127.0.0.1'))
      return Promise.resolve(new Response(null, { status: 204 }));
    return realFetch(input, init);
  });
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
  });
  await instance.start();
  const [account, bundler] = (await createWalletClient({
    transport: http(rpcUrl),
  }).getAddresses()) as [Address, Address];
  const smartAccount: Address = '0x00000000000000000000000000000000000A11cE';
  await installLocalSmartAccount(rpcUrl, smartAccount);
  api = await startLocalCdpApi({ rpcUrl, account, smartAccount, bundler });
});
afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});
afterAll(async () => {
  await api.close();
  await instance.stop();
  vi.restoreAllMocks();
  expect(fetched.filter((url) => !url.startsWith('http://127.0.0.1'))).toEqual([]);
});

const telemetry = () =>
  startTelemetry({ serviceName: 'test', otlp: { traces: false, metrics: false } });

describe('the CDP scenario on a local chain', () => {
  it('records both transfers and the user operation with their send and confirm spans', async () => {
    const { apiKeyId, apiKeySecret, walletSecret } = throwawayCredentials();
    const summary = await runScenario(telemetry(), {
      env: {
        CDP_API_KEY_ID: apiKeyId,
        CDP_API_KEY_SECRET: apiKeySecret,
        CDP_WALLET_SECRET: walletSecret,
      },
      log: () => {},
      opStack: false,
      rpcUrl,
      basePath: api.basePath,
      pollingInterval: 100,
    });

    expect(summary.error).toBeNull();
    expect(summary.findings).toEqual([]);
    expect(summary.outcome).toBe('pass');
    expect(summary.txHashes).toHaveLength(2);
    expect(summary.userOpHashes).toHaveLength(1);
  });

  it('stops with a setup error, not a finding, without a CDP key', async () => {
    const summary = await runScenario(telemetry(), {
      env: {},
      log: () => {},
      opStack: false,
      rpcUrl,
    });

    expect(summary.outcome).toBe('error');
    expect(summary.error).toMatch(/No CDP API key/);
    expect(summary.findings).toEqual([]);
  });
});
