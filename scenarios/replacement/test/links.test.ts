import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { replacementLinkFindings } from '../src/links.js';

interface Stub {
  id: string;
  parent?: string;
  start?: [number, number];
  attributes: Record<string, string>;
  links?: string[];
}

const span = ({
  id,
  parent = 'step',
  start = [1, 5],
  attributes,
  links = [],
}: Stub): ReadableSpan =>
  ({
    name: 'confirm 84532',
    attributes,
    startTime: start,
    parentSpanContext: { spanId: parent },
    links: links.map((spanId) => ({ context: { spanId } })),
    spanContext: () => ({ spanId: id }),
  }) as unknown as ReadableSpan;

const replaced = span({
  id: 'a',
  attributes: {
    'blockchain.tx.hash': '0xaa',
    'blockchain.tx.status': 'replaced',
    'blockchain.tx.replacement.hash': '0xbb',
  },
});
const mined = (overrides: Partial<Stub> = {}) =>
  span({
    id: 'b',
    attributes: { 'blockchain.tx.hash': '0xbb', 'blockchain.tx.status': 'success' },
    links: ['a'],
    ...overrides,
  });

describe('replacementLinkFindings', () => {
  it('is satisfied by a mined span with the same parent and start time that links to the replaced one', () => {
    expect(replacementLinkFindings([replaced, mined()], 84532)).toEqual([]);
  });

  it('accepts a start time up to a millisecond from the replaced one (hashspan captures it in whole milliseconds)', () => {
    expect(replacementLinkFindings([replaced, mined({ start: [1, 5 + 999_936] })], 84532)).toEqual(
      [],
    );
    expect(replacementLinkFindings([replaced, mined({ start: [1, 5 - 3] })], 84532)).toEqual([]);
  });

  it('ignores spans without a replacement', () => {
    const plain = span({
      id: 'c',
      attributes: { 'blockchain.tx.hash': '0xcc', 'blockchain.tx.status': 'success' },
    });
    expect(replacementLinkFindings([plain], 84532)).toEqual([]);
  });

  it('reports a missing span for the replacement hash', () => {
    expect(replacementLinkFindings([replaced], 84532).map((f) => f.message)).toEqual([
      'no confirm span for the hash of the replacement',
    ]);
  });

  it('reports a missing link, another parent, another start time and a status that is not success', () => {
    const messages = (m: ReadableSpan) =>
      replacementLinkFindings([replaced, m], 84532).map((f) => f.message);
    expect(messages(mined({ links: [] }))).toEqual([
      'the confirm span of the replacement has no link to the replaced one',
    ]);
    expect(messages(mined({ parent: 'elsewhere' }))).toEqual([
      'the confirm span of the replacement has another parent',
    ]);
    expect(messages(mined({ start: [1, 5 + 5_000_000] }))).toEqual([
      'the confirm span of the replacement has another start time (5 ms from the replaced one)',
    ]);
    expect(
      messages(
        mined({ attributes: { 'blockchain.tx.hash': '0xbb', 'blockchain.tx.status': 'reverted' } }),
      ),
    ).toEqual(['the confirm span of the replacement did not end as success']);
  });
});
