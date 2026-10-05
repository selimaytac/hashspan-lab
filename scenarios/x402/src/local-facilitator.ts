import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, SupportedResponse } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { type Address, createWalletClient, http, publicActions } from 'viem';
import { baseSepolia } from 'viem/chains';

/**
 * The x402 SDK's facilitator in this process, settling from `settler`, an account the local chain has unlocked.
 * Local runs only: the live run uses the public testnet facilitator.
 */
export function localFacilitator(
  rpcUrl: string,
  settler: Address,
  network: Network,
): FacilitatorClient {
  const wallet = createWalletClient({
    account: settler,
    chain: baseSepolia,
    transport: http(rpcUrl),
  }).extend(publicActions);
  const facilitator = new x402Facilitator();
  const signer = toFacilitatorEvmSigner({
    ...wallet,
    address: settler,
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  registerExactEvmScheme(facilitator, { signer, networks: network });
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The in-process facilitator answers synchronously, with network names typed as plain strings.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}
