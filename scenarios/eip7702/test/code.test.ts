import { describe, expect, it } from 'vitest';
import { readCodeUntil } from '../src/code.js';

const noSleep = async () => {};
const reads = (...answers: (string | undefined | Error)[]) => {
  let i = 0;
  return async () => {
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
};

describe('readCodeUntil', () => {
  const indicator = '0xef0100abcd';

  it('returns as soon as the code matches, after failed and stale reads', async () => {
    const read = reads(new Error('Requested resource not found.'), undefined, '0xEF0100ABCD');
    expect(await readCodeUntil(read, (code) => code === indicator, 5, 0, noSleep)).toBe(indicator);
  });

  it('returns the last code read when it never matches, so the caller reports it', async () => {
    expect(await readCodeUntil(reads(undefined), (code) => code === indicator, 3, 0, noSleep)).toBe(
      '0x',
    );
  });

  it('throws the last failure when no read succeeded', async () => {
    await expect(
      readCodeUntil(reads(new Error('Requested resource not found.')), () => true, 3, 0, noSleep),
    ).rejects.toThrow('Requested resource not found.');
  });
});
