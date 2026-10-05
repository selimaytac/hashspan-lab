import type { FacilitatorClient, HTTPAdapter } from '@x402/core/server';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import type { Address } from 'viem';

/** An EIP-3009 token the paid API takes, with the EIP-712 domain its signatures use. */
export interface PaymentAsset {
  address: Address;
  name: string;
  version: string;
}

export interface PaidApiOptions {
  facilitator: FacilitatorClient;
  network: Network;
  asset: PaymentAsset;
  /** Price per request, in the asset's smallest unit. */
  price: bigint;
  payTo: Address;
}

/** The one paid route; the request never leaves the process. */
export const PAID_URL = 'http://paid-api.lab/weather';

/**
 * A paid API at `GET /weather`, built from the x402 SDK's resource server and served as a `fetch` function in this
 * process. Verification and settlement go to `facilitator`.
 */
export async function paidApi({
  facilitator,
  network,
  asset,
  price,
  payTo,
}: PaidApiOptions): Promise<typeof fetch> {
  const resourceServer = new x402ResourceServer(facilitator);
  registerExactEvmScheme(resourceServer, { networks: [network] });
  const server = new x402HTTPResourceServer(resourceServer, {
    'GET /weather': {
      accepts: {
        scheme: 'exact',
        network,
        payTo,
        price: {
          asset: asset.address,
          amount: String(price),
          extra: { name: asset.name, version: asset.version },
        },
        maxTimeoutSeconds: 60,
      },
      description: 'Weather',
      mimeType: 'application/json',
    },
  });
  await server.initialize();

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const adapter: HTTPAdapter = {
      getHeader: (name) => request.headers.get(name) ?? undefined,
      getMethod: () => request.method,
      getPath: () => url.pathname,
      getUrl: () => request.url,
      getAcceptHeader: () => request.headers.get('accept') ?? '',
      getUserAgent: () => request.headers.get('user-agent') ?? '',
    };
    const context = { adapter, path: url.pathname, method: request.method };
    const result = await server.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      const { status, headers, body } = result.response;
      return new Response(JSON.stringify(body ?? {}), { status, headers });
    }
    if (result.type === 'no-payment-required') return new Response('{}');
    const settled = await server.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settled.success) {
      const { status, headers, body } = settled.response;
      return new Response(JSON.stringify(body ?? {}), { status, headers });
    }
    return new Response('{"temperature":21}', { status: 200, headers: settled.headers });
  };
}
