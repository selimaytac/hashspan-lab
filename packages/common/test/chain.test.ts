import { createServer, type Server } from 'node:http';
import { createPublicClient, http, parseEther } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBalance,
  assertChainId,
  BASE_SEPOLIA_CHAIN_ID,
  LabSetupError,
  labAccount,
  worstCaseCost,
} from '../src/index.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A JSON-RPC endpoint that reports `chainId` and records every method it is asked for. */
async function rpcReporting(chainId: number): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      const result = method === 'eth_chainId' ? `0x${chainId.toString(16)}` : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, methods };
}

describe('assertChainId', () => {
  it('refuses any other chain, asking for nothing but the chain id', async () => {
    const rpc = await rpcReporting(31337);
    const client = createPublicClient({ transport: http(rpc.url) });
    await expect(assertChainId(client, BASE_SEPOLIA_CHAIN_ID, 'Base Sepolia')).rejects.toThrow(
      new LabSetupError('The RPC reports chain id 31337; this run only uses Base Sepolia (84532).'),
    );
    expect(rpc.methods).toEqual(['eth_chainId']);
  });

  it('accepts the expected chain', async () => {
    const rpc = await rpcReporting(84532);
    const client = createPublicClient({ transport: http(rpc.url) });
    await expect(assertChainId(client, 84532, 'Base Sepolia')).resolves.toBeUndefined();
  });
});

describe('worstCaseCost', () => {
  it('reserves every gas limit at the max fee, with a margin, plus the value', () => {
    expect(worstCaseCost({ gasLimits: [21_000n, 100_000n], maxFeePerGas: 10n, value: 5n })).toBe(
      2n * 121_000n * 10n + 5n,
    );
    expect(worstCaseCost({ gasLimits: [21_000n], maxFeePerGas: 10n, value: 0n, margin: 3n })).toBe(
      630_000n,
    );
  });
});

describe('assertBalance', () => {
  const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const holding = (wei: bigint) => ({ getBalance: async () => wei });

  it('returns the balance when it covers the run', async () => {
    await expect(assertBalance(holding(100n), address, 100n, 'Base Sepolia')).resolves.toBe(100n);
  });

  it('says how much is needed and where to get it', async () => {
    await expect(
      assertBalance(holding(parseEther('0.0001')), address, parseEther('0.001'), 'Base Sepolia'),
    ).rejects.toThrow(
      new LabSetupError(
        'The run needs about 0.001 ETH and the account holds 0.0001; fund it from a Base Sepolia faucet.',
      ),
    );
  });

  it('leaves the address out of the message, which goes into the ledger', async () => {
    const error = (await assertBalance(holding(0n), address, 1n, 'Base Sepolia').catch(
      (caught: unknown) => caught,
    )) as Error;
    expect(error.message.toLowerCase()).not.toContain(address.toLowerCase().slice(2));
  });
});

describe('labAccount', () => {
  it('counts nonces locally', () => {
    const account = labAccount(generatePrivateKey());
    expect(account.nonceManager).toBeDefined();
  });
});
