import { createWalletClient, custom, http, RpcRequestError, type Transport } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

/**
 * An HTTP transport to `rpcUrl` that answers the EIP-5792 `wallet_*` methods with JSON-RPC -32601 (method not found),
 * as a wallet without EIP-5792 does: the answer viem's `experimental_fallback` expects before it sends the calls as
 * plain transactions. Every other request goes to `rpcUrl` unchanged.
 */
export function withoutEip5792(rpcUrl: string): Transport {
  const upstream = http(rpcUrl);
  return (options) => {
    const node = upstream(options);
    return custom(
      {
        async request({ method, params }) {
          if (typeof method === 'string' && method.startsWith('wallet_')) {
            throw new RpcRequestError({
              body: { method },
              error: { code: -32601, message: `the method ${method} does not exist` },
              url: 'lab',
            });
          }
          return node.request({ method, params } as never);
        },
      },
      { key: 'withoutEip5792', name: 'HTTP without EIP-5792', retryCount: 0 },
    )(options);
  };
}

/** Whether viem's `experimental_fallback` falls back to plain transactions when talking to `transport` directly. */
export type PublicRpcFallback = 'falls back' | 'no fallback' | 'unknown';

/**
 * Asks viem to send a batch from a fresh key with no balance: nothing can be sent either way. If viem falls back, the
 * plain transaction then fails for lack of funds; if not, the RPC's answer to `wallet_sendCalls` comes back. Base's
 * public RPC answers -32604, which viem 2.57 does not take as a reason to fall back.
 */
export async function publicRpcFallback(transport: Transport): Promise<PublicRpcFallback> {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });
  try {
    await wallet.sendCalls({
      calls: [{ to: account.address, value: 1n }],
      experimental_fallback: true,
    });
    return 'unknown';
  } catch (error) {
    const text =
      `${(error as { shortMessage?: string }).shortMessage ?? ''} ${(error as { details?: string }).details ?? ''}`.toLowerCase();
    if (/insufficient funds|exceeds the balance|gas required exceeds/.test(text))
      return 'falls back';
    if (/method|not supported|not available|does not exist/.test(text)) return 'no fallback';
    return 'unknown';
  }
}
