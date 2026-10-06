import type { Finding } from '@hashspan-lab/common';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const text = (span: ReadableSpan, key: string): string | undefined => {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
};

const hr = (time: [number, number]): number => time[0] * 1e9 + time[1];

/**
 * hashspan gives the mined span the start time of the replaced one as it captured it after that span began (a `Date`, so
 * in whole milliseconds): the two can differ by up to a millisecond (seen in about one run in ten). More than this is a
 * different start time.
 */
export const START_TOLERANCE_MS = 2;

const startDeltaMs = (mined: ReadableSpan, replaced: ReadableSpan): number =>
  (hr(mined.startTime) - hr(replaced.startTime)) / 1e6;

/**
 * hashspan's rules for the span of a mined replacement (ADR 0008): it exists for the hash the replaced span names, has
 * the same parent and start time as the replaced span, and links to it. Spans that carry no replacement are ignored.
 */
export function replacementLinkFindings(
  spans: readonly ReadableSpan[],
  chainId: number,
): Finding[] {
  const confirms = spans.filter((span) => span.name === `confirm ${chainId}`);
  const findings: Finding[] = [];
  for (const replaced of confirms.filter(
    (span) => text(span, 'blockchain.tx.status') === 'replaced',
  )) {
    const hash = text(replaced, 'blockchain.tx.replacement.hash');
    const label = `replaced confirm span of ${hash ? `${hash.slice(0, 10)}...` : 'an unknown hash'}`;
    const mined = confirms.find(
      (span) =>
        hash !== undefined && text(span, 'blockchain.tx.hash') === hash && span !== replaced,
    );
    if (!mined) {
      findings.push({
        expectation: label,
        message: 'no confirm span for the hash of the replacement',
      });
      continue;
    }
    if (text(mined, 'blockchain.tx.status') !== 'success') {
      findings.push({
        expectation: label,
        message: 'the confirm span of the replacement did not end as success',
      });
    }
    if (!mined.links.some((link) => link.context.spanId === replaced.spanContext().spanId)) {
      findings.push({
        expectation: label,
        message: 'the confirm span of the replacement has no link to the replaced one',
      });
    }
    if (mined.parentSpanContext?.spanId !== replaced.parentSpanContext?.spanId) {
      findings.push({
        expectation: label,
        message: 'the confirm span of the replacement has another parent',
      });
    }
    const delta = startDeltaMs(mined, replaced);
    if (Math.abs(delta) > START_TOLERANCE_MS) {
      findings.push({
        expectation: label,
        message: `the confirm span of the replacement has another start time (${delta} ms from the replaced one)`,
      });
    }
  }
  return findings;
}
