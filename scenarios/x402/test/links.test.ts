import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { linkFindings } from '../src/run.js';

const HASH = `0x${'ab'.repeat(32)}`;
const span = (
  name: string,
  spanId: string,
  attributes: Record<string, string>,
  links: string[] = [],
): ReadableSpan =>
  ({
    name,
    attributes,
    spanContext: () => ({ spanId }),
    links: links.map((id) => ({ context: { spanId: id } })),
  }) as unknown as ReadableSpan;

const payment = span('payment 84532', 'p1', { 'blockchain.tx.hash': HASH });

describe('linkFindings', () => {
  it('accepts a confirm span with the settlement hash that links to the payment', () => {
    const confirm = span('confirm 84532', 'c1', { 'blockchain.tx.hash': HASH }, ['p1']);
    expect(linkFindings([payment, confirm], payment)).toEqual([]);
  });

  it('reports a confirm span without the link', () => {
    const confirm = span('confirm 84532', 'c1', { 'blockchain.tx.hash': HASH }, ['other']);
    expect(linkFindings([payment, confirm], payment)).toEqual([
      expect.objectContaining({ message: 'the confirm span does not link to the payment span' }),
    ]);
  });

  it('reports a missing confirm span for the settlement hash', () => {
    const other = span('confirm 84532', 'c1', { 'blockchain.tx.hash': `0x${'cd'.repeat(32)}` }, [
      'p1',
    ]);
    expect(linkFindings([payment, other], payment)).toEqual([
      expect.objectContaining({ message: 'no confirm span records the settlement hash' }),
    ]);
  });

  it('leaves a missing payment span to the span expectations', () => {
    expect(linkFindings([], undefined)).toEqual([]);
  });
});
