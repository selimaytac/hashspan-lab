import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import {
  histogramCounts,
  loadFindings,
  loadStats,
  metricFindings,
  percentile,
  transactionCount,
} from '../src/load.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** Send and confirm spans for `hashes`; `link` false leaves the confirm span without its link. */
function spans(sent: number[], confirmed: number[], link = true): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }).getTracer('test');
  const sends = new Map<number, ReturnType<typeof tracer.startSpan>>();
  for (const n of sent) {
    const span = tracer.startSpan('send 84532', { attributes: { 'blockchain.tx.hash': hash(n) } });
    sends.set(n, span);
    span.end();
  }
  for (const n of confirmed) {
    const send = sends.get(n);
    tracer
      .startSpan('confirm 84532', {
        attributes: { 'blockchain.tx.hash': hash(n), 'blockchain.tx.fee': '100' },
        links: link && send ? [{ context: send.spanContext() }] : [],
      })
      .end();
  }
  return exporter.getFinishedSpans();
}

describe('transactionCount', () => {
  it('defaults to 30 and accepts 1 to 100', () => {
    expect(transactionCount(undefined)).toBe(30);
    expect(transactionCount(' ')).toBe(30);
    expect(transactionCount('100')).toBe(100);
    for (const bad of ['0', '101', '2.5', 'ten'])
      expect(() => transactionCount(bad)).toThrow(RangeError);
  });
});

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe('loadFindings', () => {
  it('finds nothing when each sent hash is confirmed once and linked', () => {
    expect(loadFindings(spans([1, 2, 3], [3, 1, 2]), 84532)).toEqual([]);
  });

  it('reports a send without a confirm, a confirm of an unsent hash, a duplicate and a missing link', () => {
    const expectations = (found: ReadableSpan[]) =>
      loadFindings(found, 84532).map((finding) => finding.expectation);
    expect(expectations(spans([1, 2], [1]))).toEqual(['every send confirmed']);
    expect(expectations(spans([1], [1, 9]))).toEqual(['confirm of a sent hash']);
    expect(expectations(spans([1], [1, 1]))).toEqual(['one confirm span per hash']);
    expect(expectations(spans([1], [1], false))).toEqual(['confirm links to its send']);
  });
});

describe('loadStats', () => {
  it('sums the fees of the confirm spans', () => {
    const stats = loadStats(spans([1, 2], [1, 2]), 84532);
    expect(stats.feeWei).toBe('200');
    expect(stats.confirmMs.max).not.toBeNull();
    expect(loadStats([], 84532)).toEqual({
      confirmMs: { p50: null, p95: null, max: null },
      feeWei: '0',
    });
  });
});

describe('histogramCounts and metricFindings', () => {
  const batch = (count: number) =>
    ({
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: 'blockchain.client.send.duration' },
              dataPoints: [{ value: { count } }],
            },
            {
              descriptor: { name: 'blockchain.client.confirmation.duration' },
              dataPoints: [{ value: { count: 2 } }, { value: { count: count - 2 } }],
            },
            { descriptor: { name: 'blockchain.client.fee' }, dataPoints: [{ value: { count } }] },
          ],
        },
      ],
    }) as unknown as ResourceMetrics;

  it('reads the totals from the last cumulative batch and sums data points', () => {
    const counts = histogramCounts([batch(3), batch(5)]);
    expect(counts.get('blockchain.client.confirmation.duration')).toBe(5);
    expect(metricFindings(counts, 5)).toEqual([]);
  });

  it('reports a histogram with another count, or none', () => {
    expect(metricFindings(histogramCounts([batch(4)]), 5).map((f) => f.expectation)).toEqual([
      'blockchain.client.send.duration count',
      'blockchain.client.confirmation.duration count',
      'blockchain.client.fee count',
    ]);
    expect(metricFindings(new Map(), 1)).toHaveLength(3);
  });
});
