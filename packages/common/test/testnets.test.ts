import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { LabSetupError, readLabTestnetEnv, TESTNETS, testnet } from '../src/index.js';

describe('testnet', () => {
  it('defaults to Base Sepolia', () => {
    expect(testnet(undefined).chain.id).toBe(84532);
    expect(testnet('').id).toBe('base-sepolia');
  });

  it('knows each testnet by id, with its chain id and whether it is OP-stack', () => {
    expect(TESTNETS.map((net) => [net.id, net.chain.id, net.opStack])).toEqual([
      ['base-sepolia', 84532, true],
      ['sepolia', 11155111, false],
      ['arbitrum-sepolia', 421614, false],
      ['op-sepolia', 11155420, true],
    ]);
  });

  it('has a measured cost per run for every testnet', () => {
    expect(TESTNETS.map((net) => [net.id, net.runCostWei > 0n, net.measured])).toEqual([
      ['base-sepolia', true, true],
      ['sepolia', true, true],
      ['arbitrum-sepolia', true, true],
      ['op-sepolia', true, true],
    ]);
  });

  it('refuses an unknown id as a setup error', () => {
    expect(() => testnet('mainnet')).toThrow(LabSetupError);
  });
});

describe('readLabTestnetEnv', () => {
  it("prefers the chain's own key and falls back to the Base Sepolia key", () => {
    const own = generatePrivateKey();
    const shared = generatePrivateKey();
    const sepolia = testnet('sepolia');
    expect(
      readLabTestnetEnv({ SEPOLIA_PRIVATE_KEY: own, BASE_SEPOLIA_PRIVATE_KEY: shared }, sepolia),
    ).toEqual({
      privateKey: own,
      rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    });
    expect(
      readLabTestnetEnv({ SEPOLIA_PRIVATE_KEY: '', BASE_SEPOLIA_PRIVATE_KEY: shared }, sepolia)
        .privateKey,
    ).toBe(shared);
  });

  it('names both variables when neither is set, and the one it read when malformed', () => {
    const arbitrum = testnet('arbitrum-sepolia');
    expect(() => readLabTestnetEnv({}, arbitrum)).toThrow(
      new LabSetupError(
        'Neither ARBITRUM_SEPOLIA_PRIVATE_KEY nor BASE_SEPOLIA_PRIVATE_KEY is set.',
      ),
    );
    expect(() => readLabTestnetEnv({ BASE_SEPOLIA_PRIVATE_KEY: '0x12' }, arbitrum)).toThrow(
      new LabSetupError('BASE_SEPOLIA_PRIVATE_KEY must be 0x followed by 64 hex characters.'),
    );
  });

  it('reads the RPC URL of the chain', () => {
    const op = testnet('op-sepolia');
    const env = {
      BASE_SEPOLIA_PRIVATE_KEY: generatePrivateKey(),
      OP_SEPOLIA_RPC_URL: 'https://rpc.example',
    };
    expect(readLabTestnetEnv(env, op).rpcUrl).toBe('https://rpc.example');
  });
});
