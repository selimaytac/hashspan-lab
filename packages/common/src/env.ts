import type { Hex } from 'viem';
import { LabSetupError } from './errors.js';

export interface TestnetEnv {
  privateKey: Hex;
  rpcUrl: string;
}

export interface TestnetEnvNames {
  /** Variable holding the testnet private key. */
  key: string;
  /** Variable read when `key` is unset or empty: the lab's one account, shared by its testnets. */
  fallbackKey?: string;
  /** Variable holding the RPC URL; optional, `defaultRpcUrl` is used when it is unset or empty. */
  rpcUrl: string;
  defaultRpcUrl: string;
}

export const BASE_SEPOLIA_ENV: TestnetEnvNames = {
  key: 'BASE_SEPOLIA_PRIVATE_KEY',
  rpcUrl: 'BASE_SEPOLIA_RPC_URL',
  defaultRpcUrl: 'https://sepolia.base.org',
};

/** Reads a testnet key and RPC URL from the environment, without ever echoing them back. */
export function readTestnetEnv(
  env: Record<string, string | undefined>,
  names: TestnetEnvNames,
): TestnetEnv {
  const variable = !env[names.key] && names.fallbackKey ? names.fallbackKey : names.key;
  const privateKey = env[variable];
  if (!privateKey) {
    throw new LabSetupError(
      names.fallbackKey
        ? `Neither ${names.key} nor ${names.fallbackKey} is set.`
        : `${names.key} is not set.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new LabSetupError(`${variable} must be 0x followed by 64 hex characters.`);
  }
  const rpcUrl = env[names.rpcUrl] || names.defaultRpcUrl;
  let protocol: string;
  try {
    protocol = new URL(rpcUrl).protocol;
  } catch {
    throw new LabSetupError(`${names.rpcUrl} is not a valid URL.`);
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new LabSetupError(`${names.rpcUrl} must be an http or https URL.`);
  }
  return { privateKey: privateKey as Hex, rpcUrl };
}

/** `readTestnetEnv` with Base Sepolia's variables. */
export function readBaseSepoliaEnv(env: Record<string, string | undefined>): TestnetEnv {
  return readTestnetEnv(env, BASE_SEPOLIA_ENV);
}
