import { LabSetupError } from '@hashspan-lab/common';
import { describe, expect, it } from 'vitest';
import { bundlerNames, HOSTED_BUNDLERS, hostedBundler, parseFees } from '../src/bundlers.js';

describe('bundlerNames', () => {
  it('sends through Pimlico, then Candide, by default', () => {
    expect(bundlerNames({})).toEqual(['pimlico', 'candide']);
    expect(bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: ' ' })).toEqual(['pimlico', 'candide']);
  });

  it('takes names in the given order', () => {
    expect(bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: 'candide' })).toEqual(['candide']);
    expect(bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: ' Candide , pimlico' })).toEqual([
      'candide',
      'pimlico',
    ]);
  });

  it('refuses a URL, an unknown name or a repeated one as a setup error, without echoing the value', () => {
    for (const value of [
      'https://bundler.example/rpc/SECRET-TOKEN',
      'pimlico,',
      'alchemy',
      'pimlico,pimlico',
    ]) {
      let caught: unknown;
      try {
        bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LabSetupError);
      expect((caught as Error).message).not.toContain('SECRET-TOKEN');
    }
  });

  it('does not take inherited object keys for bundler names', () => {
    expect(() => bundlerNames({ USER_OPERATIONS_V07_BUNDLERS: 'toString' })).toThrow(LabSetupError);
  });
});

describe('parseFees', () => {
  it("reads Pimlico's fast tier", () => {
    expect(
      parseFees({
        slow: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' },
        fast: { maxFeePerGas: '0x6ddd00', maxPriorityFeePerGas: '0x124f80' },
      }),
    ).toEqual({ maxFeePerGas: 0x6ddd00n, maxPriorityFeePerGas: 0x124f80n });
  });

  it("reads Candide's flat answer", () => {
    expect(parseFees({ maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x2' })).toEqual({
      maxFeePerGas: 16n,
      maxPriorityFeePerGas: 2n,
    });
  });

  it('throws on an answer without fees', () => {
    expect(() => parseFees(null)).toThrow('no fee recommendation');
    expect(() => parseFees({ fast: {} })).toThrow('no fee recommendation');
  });
});

describe('hostedBundler', () => {
  it('names the bundler and keeps its URL out of the name', () => {
    const bundler = hostedBundler('candide');
    expect(bundler.name).toBe('candide');
    expect(bundler.url).toBe(HOSTED_BUNDLERS.candide.url);
    expect(bundler.estimateFeesPerGas).toBeTypeOf('function');
  });
});
