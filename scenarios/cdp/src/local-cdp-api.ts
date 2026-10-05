// Adapted from hashspan's packages/cdp/test/mock-cdp-api.ts (Apache-2.0): the server and smart account routes.
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  testAccountAbi,
  testAccountCode,
  testEntryPointAbi,
  testEntryPointCode,
} from '@hashspan-lab/common';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  pad,
  parseTransaction,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import type { CdpCredentials } from './env.js';

/** Throwaway credentials in the formats the CDP SDK accepts; generated per run, never written down. */
export function throwawayCredentials(): CdpCredentials {
  const ed = generateKeyPairSync('ed25519');
  const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    apiKeyId: 'local-key',
    apiKeySecret: Buffer.concat([seed, pub]).toString('base64'),
    walletSecret: ec.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};

/** The fields of a v0.7 packed user operation, as the stand-in EntryPoint takes them. */
interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface LocalCdpApi {
  basePath: string;
  close: () => Promise<void>;
}

/**
 * A stand-in for the CDP API on localhost, for local runs and tests only: every account is `account`, an account the
 * local chain has unlocked, which sends what the SDK signs for it; CDP's node is the local chain. Looking up an
 * account by name answers 404, so `getOrCreateAccount` creates it.
 *
 * The smart account is the test account at `smartAccount`: preparing a user operation builds it for the stand-in
 * EntryPoint at the v0.7 address (hash, nonce, `executeBatch` call data), and sending it puts it into its own
 * `handleOps` bundle transaction from `bundler`, as CDP's bundler would. Signatures are not checked.
 */
export async function startLocalCdpApi(options: {
  rpcUrl: string;
  account: Address;
  smartAccount: Address;
  bundler: Address;
}): Promise<LocalCdpApi> {
  const anvil = createWalletClient({ account: options.account, transport: http(options.rpcUrl) });
  const bundler = createWalletClient({ account: options.bundler, transport: http(options.rpcUrl) });
  const chain = createPublicClient({ transport: http(options.rpcUrl), pollingInterval: 20 });
  const smart = options.smartAccount;
  /** Prepared and sent user operations by hash, lower-cased. */
  const operations = new Map<
    string,
    { network: string; calls: unknown[]; packed: PackedUserOperation; bundle?: Hex }
  >();
  const operationOf = (hash: string) => {
    const operation = operations.get(hash.toLowerCase());
    if (!operation) throw new Error(`local: no user operation ${hash}`);
    return operation;
  };
  const userOperationBody = (hash: string) => {
    const { network, calls, bundle } = operationOf(hash);
    return {
      network,
      userOpHash: hash,
      calls,
      status: bundle ? 'complete' : 'broadcast',
      ...(bundle ? { transactionHash: bundle } : {}),
    };
  };
  const server: Server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const body = await readJson(request);
      // Network-scoped accounts on Base read through CDP's node: the SDK asks for a token, then calls its RPC URL.
      if (request.method === 'GET' && path === '/apikeys/v1/tokens/active') {
        return reply(200, { id: 'local-token' });
      }
      if (request.method === 'POST' && /^\/rpc\/v1\/[a-z-]+\/local-token$/.test(path)) {
        const upstream = await fetch(options.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return reply(upstream.status, await upstream.json());
      }
      if (request.method === 'POST' && path === '/platform/v2/evm/accounts') {
        return reply(201, { address: options.account, name: body.name ?? 'agent' });
      }
      const send = path.match(
        /^\/platform\/v2\/evm\/accounts\/(0x[0-9a-fA-F]{40})\/send\/transaction$/,
      );
      if (request.method === 'POST' && send) {
        const tx = parseTransaction(body.transaction as `0x${string}`);
        const transactionHash = await anvil.sendTransaction({
          chain: null,
          to: tx.to ?? null,
          value: tx.value,
          data: tx.data,
        });
        // Answer once the receipt can be read, as the CDP API answers after broadcasting.
        await chain.waitForTransactionReceipt({ hash: transactionHash });
        return reply(200, { transactionHash });
      }
      if (request.method === 'POST' && path === '/platform/v2/evm/smart-accounts') {
        return reply(201, { address: smart, owners: body.owners, name: body.name ?? 'agent' });
      }
      if (
        request.method === 'POST' &&
        /^\/platform\/v2\/evm\/accounts\/0x[0-9a-fA-F]{40}\/sign$/.test(path)
      ) {
        return reply(200, { signature: `0x${'11'.repeat(65)}` });
      }
      if (
        request.method === 'POST' &&
        /^\/platform\/v2\/evm\/smart-accounts\/0x[0-9a-fA-F]{40}\/user-operations$/.test(path)
      ) {
        const calls = body.calls as { to: Address; data: Hex; value: string }[];
        const nonce = await chain.readContract({
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'getNonce',
          args: [smart, 0n],
        });
        const packed: PackedUserOperation = {
          sender: smart,
          nonce,
          initCode: '0x',
          callData: encodeFunctionData({
            abi: testAccountAbi,
            functionName: 'executeBatch',
            args: [calls.map((c) => ({ target: c.to, value: BigInt(c.value), data: c.data }))],
          }),
          accountGasLimits: pad('0x', { size: 32 }),
          preVerificationGas: 50_000n,
          gasFees: pad('0x', { size: 32 }),
          paymasterAndData: '0x',
          signature: '0x',
        };
        const userOpHash = await chain.readContract({
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'getUserOpHash',
          args: [packed],
        });
        operations.set(userOpHash.toLowerCase(), {
          network: body.network as string,
          calls: body.calls as unknown[],
          packed,
        });
        return reply(201, { ...userOperationBody(userOpHash), status: 'pending' });
      }
      const sendOperation = path.match(
        /^\/platform\/v2\/evm\/smart-accounts\/0x[0-9a-fA-F]{40}\/user-operations\/(0x[0-9a-fA-F]{64})\/send$/,
      );
      if (request.method === 'POST' && sendOperation?.[1]) {
        const operation = operationOf(sendOperation[1]);
        const bundle = await bundler.writeContract({
          chain: null,
          address: entryPoint07Address,
          abi: testEntryPointAbi,
          functionName: 'handleOps',
          args: [[{ ...operation.packed, signature: body.signature as Hex }], options.bundler],
          gas: 5_000_000n,
        });
        await chain.waitForTransactionReceipt({ hash: bundle });
        operation.bundle = bundle;
        return reply(200, { ...userOperationBody(sendOperation[1]), status: 'broadcast' });
      }
      const get = path.match(
        /^\/platform\/v2\/evm\/smart-accounts\/0x[0-9a-fA-F]{40}\/user-operations\/(0x[0-9a-fA-F]{64})$/,
      );
      if (request.method === 'GET' && get?.[1]) return reply(200, userOperationBody(get[1]));
      return reply(404, { errorType: 'not_found', errorMessage: `local: no route for ${path}` });
    } catch (error) {
      return reply(500, { errorType: 'internal', errorMessage: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    basePath: `http://127.0.0.1:${port}/platform`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Puts the stand-in EntryPoint at the v0.7 address and the test smart account at `smartAccount` on a local chain,
 * with ether for the account to pay the stand-in's gas cost from.
 */
export async function installLocalSmartAccount(
  rpcUrl: string,
  smartAccount: Address,
): Promise<void> {
  const chain = createPublicClient({ transport: http(rpcUrl) });
  const call = (method: string, params: unknown[]) =>
    chain.request({ method: method as never, params: params as never });
  await call('anvil_setCode', [entryPoint07Address, testEntryPointCode]);
  await call('anvil_setCode', [smartAccount, testAccountCode]);
  await call('anvil_setBalance', [smartAccount, '0xde0b6b3a7640000']);
}
