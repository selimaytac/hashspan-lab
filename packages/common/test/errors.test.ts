import { HttpRequestError } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { configuredUrlParts, LabSetupError, safeErrorMessage, scrub } from '../src/index.js';

/** `length` hex characters made for this run. */
const randomPart = (length: number): string => generatePrivateKey().slice(2, 2 + length);

describe('scrub', () => {
  it('removes URLs and key-sized hex strings', () => {
    const key = generatePrivateKey();
    expect(scrub(`failed at https://rpc.example/v2/apikey?x=1 with ${key}`)).toBe(
      'failed at <url> with <hex>',
    );
    expect(scrub(`raw ${key.slice(2)} and ws://host:8546`)).toBe('raw <hex> and <url>');
  });

  it('keeps short hex values such as addresses and selectors', () => {
    const text = 'to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 selector 0x2e1a7d4d';
    expect(scrub(text)).toBe(text);
  });
});

describe('safeErrorMessage', () => {
  it('keeps the message of a setup error', () => {
    expect(safeErrorMessage(new LabSetupError('BASE_SEPOLIA_PRIVATE_KEY is not set.'))).toBe(
      'BASE_SEPOLIA_PRIVATE_KEY is not set.',
    );
  });

  it("uses viem's short message, never the full one", () => {
    const error = Object.assign(
      new Error('HTTP request failed.\n\nURL: https://rpc.example/secret'),
      {
        name: 'HttpRequestError',
        shortMessage: 'HTTP request failed.',
      },
    );
    expect(safeErrorMessage(error)).toBe('HTTP request failed.');
  });

  it('scrubs a short message that carries a URL', () => {
    const error = Object.assign(new Error('x'), {
      shortMessage: 'fetch https://rpc.example/key failed',
    });
    expect(safeErrorMessage(error)).toBe('fetch <url> failed');
  });

  it("adds a failed request's method, status and details, from viem's error in the cause chain", () => {
    const secret = generatePrivateKey();
    const http = new HttpRequestError({
      body: { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [secret] },
      status: 429,
      details: 'rate limited at https://rpc.example/secret\nretry later',
      url: 'https://rpc.example/secret',
    });
    const message = safeErrorMessage(new Error('wrapped', { cause: http }));
    expect(message).toBe('Error (eth_sendRawTransaction, status 429, rate limited at <url>)');
    expect(safeErrorMessage(http)).toBe(
      'HTTP request failed. (eth_sendRawTransaction, status 429, rate limited at <url>)',
    );
    expect(message).not.toContain(secret.slice(2));
  });

  it('names a batch by its first method and leaves out what it does not have', () => {
    const batch = new HttpRequestError({
      body: [{ method: 'eth_call' }, { method: 'eth_call' }],
      details: 'fetch failed',
      url: 'https://rpc.example',
    });
    expect(safeErrorMessage(batch)).toBe(
      'HTTP request failed. (eth_call and 1 more, fetch failed)',
    );
    const odd = new HttpRequestError({
      body: { method: 'not a method' },
      url: 'https://rpc.example',
    });
    expect(safeErrorMessage(odd)).toBe('HTTP request failed.');
  });

  it('falls back to the error name, then to a fixed text', () => {
    expect(safeErrorMessage(new TypeError('https://rpc.example/secret'))).toBe('TypeError');
    expect(safeErrorMessage('https://rpc.example/secret')).toBe('Unknown error');
  });

  it("removes a configured URL's credential when a provider echoes it, also across the 100-character cut", () => {
    // Made at run time: no credential-shaped literal in the source for secret scanners to flag.
    const token = randomPart(20);
    const password = randomPart(14);
    const queryValue = randomPart(12);
    const env = {
      BASE_SEPOLIA_RPC_URL: `https://rpc.example/v2/${token}`,
      USER_OPERATIONS_BUNDLER_URL: `https://user:${password}@bundler.example/rpc?q=${queryValue}`,
    };
    const echo = (details: string) =>
      new HttpRequestError({ body: { method: 'eth_call' }, status: 401, details, url: 'x' });
    const said = safeErrorMessage(echo(`invalid project ${token} (no access)`), env);
    expect(said).toBe(
      'HTTP request failed. (eth_call, status 401, invalid project <redacted> (no access))',
    );
    for (const leaked of [password, queryValue]) {
      expect(safeErrorMessage(echo(`bad key ${leaked}`), env)).not.toContain(leaked);
    }
    // The token straddles the cut: neither it nor its prefix may survive.
    const padded = `${'word '.repeat(18)}${token} tail`; // readable padding: 90 characters, no token shape
    const cut = safeErrorMessage(echo(padded), env);
    expect(cut).not.toContain(token.slice(0, 8));
  });

  it('replaces token-shaped runs in the details, keeping readable words', () => {
    const details = `unauthorized: Bearer ${randomPart(30)} expired`;
    expect(safeErrorMessage(new HttpRequestError({ status: 403, details, url: 'x' }), {})).toBe(
      'HTTP request failed. (status 403, unauthorized: Bearer <token> expired)',
    );
  });
});

describe('configuredUrlParts', () => {
  it('takes long path segments, query values and userinfo of every *_URL variable', () => {
    const [path, password, value, other] = [
      randomPart(16),
      randomPart(11),
      randomPart(12),
      randomPart(16),
    ];
    expect(
      configuredUrlParts({
        A_RPC_URL: `https://rpc.example/v2/84532/${path}`,
        B_URL: `https://u:${password}@h.example/?q=${value}`,
        NOT_A_LINK: `https://other.example/${other}`,
        C_URL: 'not a url',
      }).sort(),
    ).toEqual([path, password, value].sort());
  });
});
