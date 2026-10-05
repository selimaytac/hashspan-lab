// Adapted from hashspan's packages/viem/test/test-bundler.ts (Apache-2.0): a stand-in for an ERC-4337 bundler, served
// over HTTP so the scenario reaches it as it reaches a hosted one.
import { createServer, type IncomingMessage } from 'node:http';
import {
  type Address,
  type BaseError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  toHex,
} from 'viem';
import {
  entryPoint07Address,
  formatUserOperation,
  getUserOperationHash,
  toPackedUserOperation,
} from 'viem/account-abstraction';
import { testEntryPointAbi } from './entry-point.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface LocalBundler {
  /** The bundler's URL; its path carries `token`, as a hosted bundler's URL carries an API key. */
  url: string;
  close: () => Promise<void>;
}

const readJson = async (
  request: IncomingMessage,
): Promise<{ id?: unknown; method: string; params?: unknown[] }> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/**
 * A bundler for the local chain at `rpcUrl` and the stand-in EntryPoint at the v0.7 address: it puts each operation
 * into its own `handleOps` bundle transaction from `executor`, an account the chain has unlocked, and builds receipts
 * from that transaction's logs, shaped like Alto's. Other methods go to the chain. Local runs and tests only.
 */
export async function startLocalBundler(options: {
  rpcUrl: string;
  executor: Address;
  token: string;
}): Promise<LocalBundler> {
  const reader = createPublicClient({ transport: http(options.rpcUrl) });
  const executor = createWalletClient({
    account: options.executor,
    transport: http(options.rpcUrl),
  });
  const bundles = new Map<string, Hex>();

  const send = async (rpcOperation: Record<string, unknown>, entryPoint: Address): Promise<Hex> => {
    const operation = formatUserOperation(rpcOperation as never);
    const packed = toPackedUserOperation(operation);
    const hash = getUserOperationHash({
      chainId: await reader.getChainId(),
      entryPointAddress: entryPoint,
      entryPointVersion: '0.7',
      userOperation: operation,
    });
    const bundle = await executor.writeContract({
      chain: null,
      address: entryPoint,
      abi: testEntryPointAbi,
      functionName: 'handleOps',
      args: [[packed], options.executor],
      gas: 5_000_000n,
    });
    await reader.waitForTransactionReceipt({ hash: bundle });
    bundles.set(hash.toLowerCase(), bundle);
    return hash;
  };

  const receipt = async (userOpHash: Hex): Promise<Record<string, unknown> | null> => {
    const bundle = bundles.get(userOpHash.toLowerCase());
    if (!bundle) return null;
    const raw = (await reader.request({
      method: 'eth_getTransactionReceipt',
      params: [bundle],
    })) as { logs: { topics: [Hex, ...Hex[]]; data: Hex }[] } | null;
    if (!raw) return null;
    const events = raw.logs.flatMap((log) => {
      try {
        const event = decodeEventLog({
          abi: testEntryPointAbi,
          data: log.data,
          topics: log.topics,
        });
        return event.args.userOpHash.toLowerCase() === userOpHash.toLowerCase() ? [event] : [];
      } catch {
        return [];
      }
    });
    const operation = events.find((event) => event.eventName === 'UserOperationEvent');
    if (operation?.eventName !== 'UserOperationEvent') return null;
    const { args } = operation;
    return {
      userOpHash,
      entryPoint: entryPoint07Address.toLowerCase(),
      sender: args.sender,
      nonce: toHex(args.nonce),
      actualGasCost: toHex(args.actualGasCost),
      actualGasUsed: toHex(args.actualGasUsed),
      success: args.success,
      ...(args.paymaster !== ZERO_ADDRESS ? { paymaster: args.paymaster } : {}),
      logs: [],
      receipt: raw,
    };
  };

  // Like Alto, estimation runs the operation's call and refuses one that reverts.
  const simulate = async (operation: { sender: Address; callData: Hex }, entryPoint: Address) => {
    try {
      await reader.request({
        method: 'eth_call',
        params: [{ from: entryPoint, to: operation.sender, data: operation.callData }, 'latest'],
      });
    } catch (error) {
      const reverted = (error as BaseError).walk(
        (cause) => typeof (cause as { data?: unknown }).data === 'string',
      ) as { data?: Hex } | null;
      throw Object.assign(
        new Error(
          `UserOperation reverted during simulation with reason: ${reverted?.data ?? '0x'}`,
        ),
        { code: -32521 },
      );
    }
  };

  const handle = async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId':
        return toHex(await reader.getChainId());
      case 'eth_supportedEntryPoints':
        return [entryPoint07Address];
      case 'eth_estimateUserOperationGas':
        await simulate(args[0] as { sender: Address; callData: Hex }, args[1] as Address);
        return {
          preVerificationGas: toHex(50_000),
          verificationGasLimit: toHex(200_000),
          callGasLimit: toHex(500_000),
          paymasterVerificationGasLimit: toHex(0),
          paymasterPostOpGasLimit: toHex(0),
        };
      case 'eth_sendUserOperation':
        return send(args[0] as Record<string, unknown>, args[1] as Address);
      case 'eth_getUserOperationReceipt':
        return receipt(args[0] as Hex);
      default:
        return reader.request({ method, params: args } as never);
    }
  };

  const path = `/rpc/v1/base-sepolia/${options.token}`;
  const server = createServer(async (request, response) => {
    const reply = (body: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    const { id, method, params } = await readJson(request);
    try {
      reply({ jsonrpc: '2.0', id, result: await handle(method, params ?? []) });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      reply({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof code === 'number' ? code : -32603,
          message: (error as Error).message,
        },
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
