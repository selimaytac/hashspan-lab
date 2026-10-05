import { describe, expect, it } from 'vitest';
import { deployCode, vaultCode } from '../src/vault.js';

describe('vault bytecode', () => {
  it('wraps the runtime code in creation code that returns it', () => {
    const runtime = vaultCode(1n, 2n);
    const creation = deployCode(runtime);
    expect(creation.endsWith(runtime.slice(2))).toBe(true);
    expect(creation.slice(0, 4)).toBe('0x60');
  });

  it('refuses runtime code longer than 255 bytes', () => {
    expect(() => deployCode(`0x${'00'.repeat(256)}`)).toThrow('runtime code too long');
  });
});
