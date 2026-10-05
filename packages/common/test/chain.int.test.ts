import { Instance } from 'prool';
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  parseEther,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertBalance,
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  LabSetupError,
  labAccount,
} from '../src/index.js';

// A local chain that reports Base Sepolia's chain id stands in for the testnet: tests never leave localhost.
const PORT = 18645;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
  chainId: BASE_SEPOLIA_CHAIN_ID,
});
const rpc = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

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
afterAll(async () => {
  await instance.stop();
});

describe('on a chain with Base Sepolia chain id', () => {
  it('accepts the chain and refuses another id', async () => {
    await expect(
      assertChainId(rpc, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia'),
    ).resolves.toBeUndefined();
    await expect(assertChainId(rpc, 8453, 'Base')).rejects.toThrow(LabSetupError);
  });

  it('checks the balance before anything is sent', async () => {
    const { address } = await fundedKey('0.000001');
    const before = await rpc.getTransactionCount({ address });
    await expect(assertBalance(rpc, address, parseEther('0.001'), 'Base Sepolia')).rejects.toThrow(
      `fund it from a Base Sepolia faucet`,
    );
    await expect(
      assertBalance(rpc, address, parseEther('0.0000001'), 'Base Sepolia'),
    ).resolves.toBe(parseEther('0.000001'));
    expect(await rpc.getTransactionCount({ address })).toBe(before);
  });

  it('sends transactions back to back with locally counted nonces', async () => {
    const { privateKey, address } = await fundedKey('0.001');
    const wallet = createWalletClient({
      account: labAccount(privateKey),
      chain: baseSepolia,
      transport: http(RPC_URL),
    }).extend(publicActions);
    // Without waiting in between, as an agent's tools may do.
    const hashes = await Promise.all([
      wallet.sendTransaction({ to: address, value: 1n }),
      wallet.sendTransaction({ to: address, value: 1n }),
    ]);
    const receipts = await Promise.all(
      hashes.map((hash) => wallet.waitForTransactionReceipt({ hash, pollingInterval: 100 })),
    );
    expect(receipts.map((r) => r.status)).toEqual(['success', 'success']);
    const nonces = await Promise.all(
      hashes.map(async (hash) => (await rpc.getTransaction({ hash })).nonce),
    );
    expect(nonces.sort()).toEqual([0, 1]);
  });
});
