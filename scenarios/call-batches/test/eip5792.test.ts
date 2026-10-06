import { custom, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { publicRpcFallback } from '../src/eip5792.js';

/** A node that answers wallet_sendCalls with `code`, and every other method as an empty account would. */
const node = (code: number, message: string) =>
  custom({
    async request({ method }) {
      if (method === 'wallet_sendCalls') {
        throw new RpcRequestError({ body: {}, error: { code, message }, url: 'test' });
      }
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_getBalance') return '0x0';
      throw new RpcRequestError({
        body: {},
        error: { code: -32000, message: 'insufficient funds for gas * price + value' },
        url: 'test',
      });
    },
  });

describe("viem's fallback on an RPC", () => {
  it("is taken on Base's public RPC answer (-32604) since viem 2.57.3 (wevm/viem#5178, fixed in #5180)", async () => {
    expect(await publicRpcFallback(node(-32604, 'this request method is not supported'))).toBe(
      'falls back',
    );
  });

  it('is taken on method not found (-32601)', async () => {
    expect(await publicRpcFallback(node(-32601, 'the method does not exist'))).toBe('falls back');
  });
});
