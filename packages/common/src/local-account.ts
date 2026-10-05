import { type Address, encodeFunctionData, type PublicClient } from 'viem';
import {
  entryPoint07Abi,
  entryPoint07Address,
  type SmartAccount,
  type SmartAccountImplementation,
  toSmartAccount,
} from 'viem/account-abstraction';
import { testAccountAbi, testAccountCode, testEntryPointCode } from './entry-point.js';

/** Where the local runs install the test smart account. */
export const LOCAL_SMART_ACCOUNT: Address = '0x00000000000000000000000000000000000A11cE';
const SIGNATURE = `0x${'11'.repeat(65)}` as const;

/** Puts the stand-in EntryPoint at the v0.7 address and the test smart account on a local chain. */
export async function installLocalSmartAccount(client: PublicClient): Promise<void> {
  const setCode = (address: Address, code: string) =>
    client.request({ method: 'anvil_setCode' as never, params: [address, code] as never });
  await setCode(entryPoint07Address, testEntryPointCode);
  await setCode(LOCAL_SMART_ACCOUNT, testAccountCode);
}

/**
 * The test smart account as a viem smart account, as in hashspan's user operation tests: the stand-in EntryPoint
 * checks no signature, so the owner signs nothing.
 */
export const localSmartAccount = async (
  client: SmartAccountImplementation['client'],
): Promise<SmartAccount> =>
  toSmartAccount({
    client,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: '0.7' },
    getAddress: async () => LOCAL_SMART_ACCOUNT,
    encodeCalls: async (calls) =>
      encodeFunctionData({
        abi: testAccountAbi,
        functionName: 'executeBatch',
        args: [
          calls.map((call) => ({
            target: call.to,
            value: call.value ?? 0n,
            data: call.data ?? '0x',
          })),
        ],
      }),
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getStubSignature: async () => SIGNATURE,
    signMessage: async () => SIGNATURE,
    signTypedData: async () => SIGNATURE,
    signUserOperation: async () => SIGNATURE,
  });
