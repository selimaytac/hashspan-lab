import { createWalletClient, type Transport } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

/** Whether viem's `experimental_fallback` falls back to plain transactions when talking to `transport` directly. */
export type PublicRpcFallback = 'falls back' | 'no fallback' | 'unknown';

/**
 * Asks viem to send a batch from a fresh key with no balance: nothing can be sent either way. If viem falls back, the
 * plain transaction then fails for lack of funds; if not, the RPC's answer to `wallet_sendCalls` comes back. Base's
 * public RPC answers -32604, which viem 2.57.2 did not take as a reason to fall back (wevm/viem#5178); 2.57.3 does
 * (#5180).
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
