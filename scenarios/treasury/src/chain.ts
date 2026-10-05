import { withHashspan } from '@hashspan/viem';
import {
  assertBalance,
  assertChainId,
  LabSetupError,
  labAccount,
  readLabTestnetEnv,
  type Testnet,
  worstCaseCost,
} from '@hashspan-lab/common';
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hash,
  http,
  type PublicClient,
  parseEther,
  type Transport,
  type WalletClient,
} from 'viem';
import { AGENT_NAME } from './names.js';
import { deployCode, vaultCode } from './vault.js';

export { AGENT_NAME };

export const PAY_ETH = '0.00001';
export const WITHDRAW_ETH = '0.00002';
export const WITHDRAW_LIMIT_ETH = '0.00001';
/** Gas the withdrawal is sent with: explicit, so the rejected withdrawal is mined instead of failing estimation. */
export const WITHDRAW_GAS = 100_000n;

// One withHashspan() result for every client, so confirm spans link to their send spans.
export const hashspan: ReturnType<typeof withHashspan> = withHashspan({
  agent: { name: AGENT_NAME },
  recordFunctionArguments: true,
});

/** The chain the agent runs on: traced clients, the account it pays (itself) and the vault it withdraws from. */
export interface TreasuryChain {
  chainId: number;
  explorer: string;
  wallet: Pick<WalletClient<Transport, Chain, Account>, 'sendTransaction' | 'writeContract'>;
  reader: Pick<PublicClient<Transport, Chain>, 'waitForTransactionReceipt'>;
  vendor: Address;
  vault: Address;
  /** The vault deployment: setup, not traced. */
  setupHashes: Hash[];
}

export interface ChainOptions {
  /** Receipt polling interval in ms; viem's default for the chain when unset. */
  pollingInterval?: number;
}

/**
 * The testnet `net` (Base Sepolia unless `LAB_TESTNET` names another), with the lab account. Refuses any other chain,
 * checks that the balance covers the worst case, and deploys a vault that rejects every withdrawal. The deployment
 * is not traced: it is setup, not something the agent does. The vendor is the account itself, so the payment comes
 * back.
 */
export async function treasuryChain(
  net: Testnet,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  options: ChainOptions = {},
): Promise<TreasuryChain> {
  const { chain, explorer, label } = net;
  const { privateKey, rpcUrl } = readLabTestnetEnv(env, net);
  const polling =
    options.pollingInterval === undefined ? {} : { pollingInterval: options.pollingInterval };
  const transport = () => http(rpcUrl);
  const setup = createPublicClient({ chain, transport: transport(), ...polling });
  await assertChainId(setup, chain.id, label);

  const account = labAccount(privateKey);
  const creation = deployCode(vaultCode(parseEther(WITHDRAW_LIMIT_ETH), parseEther(WITHDRAW_ETH)));
  const [{ maxFeePerGas }, deployGas] = await Promise.all([
    setup.estimateFeesPerGas(),
    setup.estimateGas({ account: account.address, data: creation }),
  ]);
  const needed = worstCaseCost({
    gasLimits: [deployGas, 21_000n, WITHDRAW_GAS],
    maxFeePerGas,
    value: parseEther(PAY_ETH),
  });
  await assertBalance(setup, account.address, needed, label);
  log(`Account ${account.address} covers the run on ${label}.`);

  const deployer = createWalletClient({ account, chain, transport: transport() });
  const deployment = await deployer.sendTransaction({ data: creation, gas: deployGas });
  // The receipt's status says whether the code was stored; reading the code back could reach a node that lags.
  const { status, contractAddress } = await setup.waitForTransactionReceipt({ hash: deployment });
  if (status !== 'success' || !contractAddress) {
    throw new LabSetupError(`The vault was not deployed: ${explorer}/tx/${deployment}`);
  }
  log(`Vault deployed at ${contractAddress}: ${explorer}/tx/${deployment}`);

  return {
    chainId: chain.id,
    explorer,
    wallet: createWalletClient({
      account,
      chain,
      transport: transport(),
      ...polling,
    }).extend(hashspan),
    reader: createPublicClient({ chain, transport: transport(), ...polling }).extend(hashspan),
    vendor: account.address,
    vault: contractAddress,
    setupHashes: [deployment],
  };
}
