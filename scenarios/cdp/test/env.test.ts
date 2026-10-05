import { LabSetupError } from '@hashspan-lab/common';
import { describe, expect, it } from 'vitest';
import { readCdpEnv } from '../src/env.js';

describe('readCdpEnv', () => {
  it('reads the three CDP variables', () => {
    expect(
      readCdpEnv({
        CDP_API_KEY_ID: 'id',
        CDP_API_KEY_SECRET: 'secret',
        CDP_WALLET_SECRET: 'wallet',
      }),
    ).toEqual({ apiKeyId: 'id', apiKeySecret: 'secret', walletSecret: 'wallet' });
  });

  it('names what is missing as a setup error, without any value', () => {
    const read = () => readCdpEnv({ CDP_API_KEY_ID: 'visible-id', CDP_API_KEY_SECRET: '' });
    expect(read).toThrow(LabSetupError);
    expect(read).toThrow('CDP_API_KEY_SECRET, CDP_WALLET_SECRET not set');
    expect(read).not.toThrow(/visible-id/);
  });
});
