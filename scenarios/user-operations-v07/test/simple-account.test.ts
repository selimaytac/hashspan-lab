import {
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  recoverMessageAddress,
  toFunctionSelector,
} from 'viem';
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import {
  SIMPLE_ACCOUNT_FACTORY_V07,
  STUB_SIGNATURE,
  simpleAccountAbi,
  simpleAccountFactoryAbi,
  toSimpleAccountV07,
} from '../src/simple-account.js';

const ACCOUNT = '0x1234567890123456789012345678901234567890';
const TARGET = '0x00000000000000000000000000000000000000AA';

/** A client whose transport answers the factory's `getAddress` with ACCOUNT and records the calls; no network. */
function stubClient() {
  const calls: { to: string; data: Hex }[] = [];
  const client = createClient({
    chain: baseSepolia,
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_call') {
          const [call] = params as [{ to: string; data: Hex }];
          calls.push(call);
          return encodeAbiParameters([{ type: 'address' }], [ACCOUNT]);
        }
        if (method === 'eth_chainId') return '0x14a34';
        // Not deployed yet.
        if (method === 'eth_getCode') return '0x';
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  return { client, calls };
}

describe('toSimpleAccountV07', () => {
  it('targets EntryPoint v0.7 and takes its address from the factory for the owner and salt', async () => {
    const { client, calls } = stubClient();
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = await toSimpleAccountV07({ client, owner, salt: 3n });

    expect(account.entryPoint.address).toBe(entryPoint07Address);
    expect(account.entryPoint.version).toBe('0.7');
    expect(account.address).toBe(ACCOUNT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to.toLowerCase()).toBe(SIMPLE_ACCOUNT_FACTORY_V07.toLowerCase());
    const { functionName, args } = decodeFunctionData({
      abi: simpleAccountFactoryAbi,
      data: calls[0]?.data ?? '0x',
    });
    expect(functionName).toBe('getAddress');
    expect(args).toEqual([owner.address, 3n]);
  });

  it('deploys through the factory with createAccount(owner, salt)', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = await toSimpleAccountV07({ client: stubClient().client, owner });
    const { factory, factoryData } = await account.getFactoryArgs();

    expect(factory).toBe(SIMPLE_ACCOUNT_FACTORY_V07);
    const { functionName, args } = decodeFunctionData({
      abi: simpleAccountFactoryAbi,
      data: factoryData ?? '0x',
    });
    expect(functionName).toBe('createAccount');
    expect(args).toEqual([owner.address, 0n]);
  });

  it('batches the calls with executeBatch(address[],uint256[],bytes[])', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = await toSimpleAccountV07({ client: stubClient().client, owner });
    const data = await account.encodeCalls([
      { to: TARGET, value: 1n },
      { to: owner.address, data: '0xabcd' },
    ]);

    expect(data.slice(0, 10)).toBe(toFunctionSelector('executeBatch(address[],uint256[],bytes[])'));
    const { args } = decodeFunctionData({ abi: simpleAccountAbi, data });
    expect(args).toEqual([
      [TARGET, owner.address],
      [1n, 0n],
      ['0x', '0xabcd'],
    ]);
  });

  it('signs the operation hash as an EIP-191 message of the owner, as SimpleAccount recovers it', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = await toSimpleAccountV07({ client: stubClient().client, owner });
    const operation = {
      callData: '0x' as Hex,
      callGasLimit: 100_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      nonce: 0n,
      preVerificationGas: 50_000n,
      verificationGasLimit: 200_000n,
      signature: '0x' as Hex,
    };
    const signature = await account.signUserOperation(operation);
    const hash = getUserOperationHash({
      chainId: baseSepolia.id,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...operation, sender: ACCOUNT },
    });

    expect(await recoverMessageAddress({ message: { raw: hash }, signature })).toBe(owner.address);
  });

  it('estimates with a 65-byte stub signature', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = await toSimpleAccountV07({ client: stubClient().client, owner });
    const stub = await account.getStubSignature();

    expect(stub).toBe(STUB_SIGNATURE);
    expect((stub.length - 2) / 2).toBe(65);
  });
});
