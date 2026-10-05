import { type Address, createPublicClient, createWalletClient, type Hex, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { PaymentAsset } from './paid-api.js';
import { testUsdAbi, testUsdBytecode } from './test-usd.js';

/** Anvil's first account, unlocked on every Anvil: deploys the token and settles as the local facilitator. */
export const ANVIL_SETTLER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Deploys the local test token and mints `amount` to the holder of `privateKey`. */
export async function deployTestUsd(
  rpcUrl: string,
  privateKey: Hex,
  amount: bigint,
): Promise<PaymentAsset> {
  const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({
    account: ANVIL_SETTLER,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const deployed = await wallet.deployContract({ abi: testUsdAbi, bytecode: testUsdBytecode });
  const { contractAddress } = await reader.waitForTransactionReceipt({ hash: deployed });
  if (!contractAddress) throw new Error('The test token was not deployed.');
  await reader.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: contractAddress,
      abi: testUsdAbi,
      functionName: 'mint',
      args: [privateKeyToAccount(privateKey).address, amount],
    }),
  });
  return { address: contractAddress, name: 'Test USD', version: '1' };
}
