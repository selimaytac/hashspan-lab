import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { createBundlerClient, entryPoint07Address } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  freePort,
  installLocalSmartAccount,
  LOCAL_SMART_ACCOUNT,
  type LocalBundler,
  localSmartAccount,
  startLocalBundler,
} from '../src/index.js';

let instance: ReturnType<typeof Instance.anvil>;
let bundler: LocalBundler;
let rpcUrl: string;
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
    chainId: 84532,
  });
  await instance.start();
  const client = createPublicClient({ transport: http(rpcUrl) });
  await installLocalSmartAccount(client);
  await client.request({
    method: 'anvil_setBalance' as never,
    params: [LOCAL_SMART_ACCOUNT, numberToHex(parseEther('1'))] as never,
  });
  // Anvil's second account sends the bundles.
  bundler = await startLocalBundler({
    rpcUrl,
    executor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    token: 'test-token',
  });
});
afterAll(async () => {
  await bundler.close();
  await instance.stop();
});

describe('the local bundler with the stand-in EntryPoint and test account', () => {
  it('bundles two operations in a row and answers their receipts', async () => {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const bundlerClient = createBundlerClient({
      account: await localSmartAccount(client),
      client,
      transport: http(bundler.url),
      pollingInterval: 100,
    });
    expect(await bundlerClient.getSupportedEntryPoints()).toEqual([entryPoint07Address]);
    const nonces = new Set<bigint>();
    for (let i = 0; i < 2; i++) {
      const hash = await bundlerClient.sendUserOperation({
        calls: [{ to: LOCAL_SMART_ACCOUNT, value: 0n }],
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      });
      const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
      expect(receipt.success).toBe(true);
      expect(receipt.sender.toLowerCase()).toBe(LOCAL_SMART_ACCOUNT.toLowerCase());
      nonces.add(BigInt(receipt.nonce));
      expect(receipt.receipt.status).toBe('success');
    }
    expect(nonces.size).toBe(2);
  });

  it('answers only under the path with its token', async () => {
    const response = await fetch(bundler.url.replace('test-token', 'other-token'), {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    });
    expect(response.status).toBe(404);
  });
});
