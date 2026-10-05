import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { LabSetupError, readBaseSepoliaEnv, readTestnetEnv } from '../src/index.js';

describe('readBaseSepoliaEnv', () => {
  it('reads the key and the RPC URL, with the public endpoint as default', () => {
    const key = generatePrivateKey();
    expect(readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: key })).toEqual({
      privateKey: key,
      rpcUrl: 'https://sepolia.base.org',
    });
    expect(
      readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: key, BASE_SEPOLIA_RPC_URL: '' }).rpcUrl,
    ).toBe('https://sepolia.base.org');
    expect(
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'https://rpc.example',
      }).rpcUrl,
    ).toBe('https://rpc.example');
  });

  it('says which variable is missing', () => {
    expect(() => readBaseSepoliaEnv({})).toThrow(
      new LabSetupError('BASE_SEPOLIA_PRIVATE_KEY is not set.'),
    );
  });

  it('rejects a malformed key without repeating it', () => {
    // A key with one character too many: the error must not leak any of it.
    const malformed = `${generatePrivateKey()}a`;
    let message = '';
    try {
      readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: malformed });
    } catch (error) {
      expect(error).toBeInstanceOf(LabSetupError);
      message = (error as Error).message;
    }
    expect(message).toBe('BASE_SEPOLIA_PRIVATE_KEY must be 0x followed by 64 hex characters.');
    expect(() =>
      readBaseSepoliaEnv({ BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey().slice(2) }),
    ).toThrow(LabSetupError);
  });

  it('rejects an RPC URL that is not http or https, without repeating it', () => {
    const key = generatePrivateKey();
    expect(() =>
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'not a url secret',
      }),
    ).toThrow(new LabSetupError('BASE_SEPOLIA_RPC_URL is not a valid URL.'));
    expect(() =>
      readBaseSepoliaEnv({
        BASE_SEPOLIA_PRIVATE_KEY: key,
        BASE_SEPOLIA_RPC_URL: 'ws://rpc.example/secret',
      }),
    ).toThrow(new LabSetupError('BASE_SEPOLIA_RPC_URL must be an http or https URL.'));
  });
});

describe('readTestnetEnv', () => {
  it('reads the variables it is given', () => {
    const key = generatePrivateKey();
    const names = {
      key: 'OTHER_KEY',
      rpcUrl: 'OTHER_RPC',
      defaultRpcUrl: 'https://default.example',
    };
    expect(readTestnetEnv({ OTHER_KEY: key }, names)).toEqual({
      privateKey: key,
      rpcUrl: 'https://default.example',
    });
    expect(() => readTestnetEnv({ BASE_SEPOLIA_PRIVATE_KEY: key }, names)).toThrow(
      'OTHER_KEY is not set.',
    );
  });
});
