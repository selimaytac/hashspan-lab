import { LabSetupError } from '@hashspan-lab/common';

/** The CDP SDK's own variable names, which `new CdpClient()` also reads. */
export const CDP_ENV = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'] as const;

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

/** Reads the CDP API key and wallet secret from the environment, naming only what is missing, never a value. */
export function readCdpEnv(env: Record<string, string | undefined>): CdpCredentials {
  const missing = CDP_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new LabSetupError(
      `No CDP API key: ${missing.join(', ')} not set. Create a key and a wallet secret in the CDP portal.`,
    );
  }
  return {
    apiKeyId: env.CDP_API_KEY_ID as string,
    apiKeySecret: env.CDP_API_KEY_SECRET as string,
    walletSecret: env.CDP_WALLET_SECRET as string,
  };
}
