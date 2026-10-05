import { type Address, encodeFunctionData, type Hex, type LocalAccount, parseAbi } from 'viem';
import {
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  type SmartAccount,
  type SmartAccountImplementation,
  toSmartAccount,
} from 'viem/account-abstraction';
import { readContract } from 'viem/actions';

/**
 * eth-infinitism's `SimpleAccountFactory` for EntryPoint v0.7 (release v0.7.0), at its deterministic address. On Base
 * Sepolia it has code, and its `accountImplementation()` reports EntryPoint v0.7 from `entryPoint()` (see
 * docs/research/entrypoint-v07-2026-10-04.md).
 */
export const SIMPLE_ACCOUNT_FACTORY_V07: Address = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';

/** The functions of SimpleAccountFactory and SimpleAccount (v0.7.0) the account calls; signatures only. */
export const simpleAccountFactoryAbi = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
]);
export const simpleAccountAbi = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);

/**
 * A signature of the right shape for gas estimation. SimpleAccount recovers the signer with OpenZeppelin's ECDSA, which
 * reverts on a malformed signature (AA23), so the stub must be a valid encoding; it is the one viem's Solady account
 * uses.
 */
export const STUB_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

export interface SimpleAccountOptions {
  client: SmartAccountImplementation['client'];
  owner: LocalAccount;
  /** Account index of the owner; the address depends on owner and salt, so no one else can take it. Default 0. */
  salt?: bigint;
  factory?: Address;
}

/**
 * eth-infinitism's SimpleAccount (v0.7.0) as a viem smart account for EntryPoint v0.7, owned by `owner`: deployed by
 * the operation's `initCode` through the factory on first use, calls batched with `executeBatch`, and the operation
 * hash signed as an EIP-191 message, which is what `SimpleAccount._validateSignature` recovers. viem 2.57 ships no
 * v0.7 account with a factory on Base Sepolia (its Solady account's factory has no code there), hence this one.
 */
export async function toSimpleAccountV07({
  client,
  owner,
  salt = 0n,
  factory = SIMPLE_ACCOUNT_FACTORY_V07,
}: SimpleAccountOptions): Promise<SmartAccount> {
  const entryPoint = {
    abi: entryPoint07Abi,
    address: entryPoint07Address,
    version: '0.7',
  } as const;
  let address: Address | undefined;
  const getAddress = async (): Promise<Address> => {
    address ??= await readContract(client, {
      address: factory,
      abi: simpleAccountFactoryAbi,
      functionName: 'getAddress',
      args: [owner.address, salt],
    });
    return address;
  };
  return toSmartAccount({
    client,
    entryPoint,
    getAddress,
    async encodeCalls(calls) {
      return encodeFunctionData({
        abi: simpleAccountAbi,
        functionName: 'executeBatch',
        args: [
          calls.map((call) => call.to),
          calls.map((call) => call.value ?? 0n),
          calls.map((call) => call.data ?? '0x'),
        ],
      });
    },
    async getFactoryArgs() {
      return {
        factory,
        factoryData: encodeFunctionData({
          abi: simpleAccountFactoryAbi,
          functionName: 'createAccount',
          args: [owner.address, salt],
        }),
      };
    },
    async getStubSignature() {
      return STUB_SIGNATURE;
    },
    async signMessage({ message }) {
      return owner.signMessage({ message });
    },
    async signTypedData(typedData) {
      return owner.signTypedData(typedData as never);
    },
    async signUserOperation({ chainId = client.chain?.id, ...userOperation }) {
      if (chainId === undefined)
        throw new Error('The client has no chain to sign the operation for');
      const hash = getUserOperationHash({
        chainId,
        entryPointAddress: entryPoint.address,
        entryPointVersion: entryPoint.version,
        userOperation: { ...userOperation, sender: await getAddress() },
      });
      return owner.signMessage({ message: { raw: hash } });
    },
  });
}
