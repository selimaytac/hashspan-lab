import { Instance } from 'prool';
import {
  type Address,
  BaseError,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  http,
  parseAbi,
} from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCode, freePort, revertingWith } from '../src/index.js';

let instance: ReturnType<typeof Instance.anvil>;
let rpcUrl: string;
beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  instance = Instance.anvil({
    binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
    port,
  });
  await instance.start();
});
afterAll(async () => {
  await instance.stop();
});

describe('a contract deployed with deployCode(revertingWith(data))', () => {
  it('reverts every call with exactly that data', async () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error Blocked(uint256 code)']),
      errorName: 'Blocked',
      args: [7n],
    });
    // Anvil's first account is unlocked on the node.
    const [account] = (await createWalletClient({
      chain: foundry,
      transport: http(rpcUrl),
    }).getAddresses()) as [Address];
    const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
    const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    const hash = await wallet.sendTransaction({ data: deployCode(revertingWith(data)) });
    const { contractAddress } = await reader.waitForTransactionReceipt({ hash });

    const error = await reader
      .call({ to: contractAddress ?? undefined, data: '0x12345678' })
      .catch((caught: unknown) => caught);
    // The revert data viem carries on the error it raises for the call.
    const reverted =
      error instanceof BaseError
        ? (error.walk((cause) => typeof (cause as { data?: unknown }).data === 'string') as {
            data?: string;
          } | null)
        : null;
    expect(reverted?.data).toBe(data);
  });
});

describe('the helpers', () => {
  it('refuse payloads too long for the one-byte length operands', () => {
    expect(() => revertingWith(`0x${'00'.repeat(256)}`)).toThrow();
    expect(() => deployCode(`0x${'00'.repeat(256)}`)).toThrow();
  });
});
