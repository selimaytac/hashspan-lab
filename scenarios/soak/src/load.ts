import type { Finding } from '@hashspan-lab/common';
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/** Transactions per run unless `SOAK_TRANSACTIONS` says otherwise, and the most a run may send. */
export const DEFAULT_TRANSACTIONS = 30;
export const MAX_TRANSACTIONS = 100;

/** The number of transactions from `SOAK_TRANSACTIONS`: a whole number from 1 to the maximum, else the default. */
export function transactionCount(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_TRANSACTIONS;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRANSACTIONS) {
    throw new RangeError(`SOAK_TRANSACTIONS must be a whole number from 1 to ${MAX_TRANSACTIONS}`);
  }
  return count;
}

/** The `p`-th percentile (0 to 100) of `values`, nearest rank; undefined for no values. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

const ms = (span: ReadableSpan): number =>
  Math.round(span.duration[0] * 1e3 + span.duration[1] / 1e6);

const hashOf = (span: ReadableSpan): string | undefined => {
  const value = span.attributes['blockchain.tx.hash'];
  return typeof value === 'string' ? value : undefined;
};

export interface LoadStats {
  confirmMs: { p50: number | null; p95: number | null; max: number | null };
  /** Sum of the confirm spans' fees in wei, as a decimal string. */
  feeWei: string;
}

/** Confirmation durations and total fee of the run, from its confirm spans. */
export function loadStats(spans: readonly ReadableSpan[], chainId: number): LoadStats {
  const confirms = spans.filter((span) => span.name === `confirm ${chainId}`);
  const durations = confirms.map(ms);
  const fee = confirms.reduce((sum, span) => {
    const value = span.attributes['blockchain.tx.fee'];
    return typeof value === 'string' && /^\d+$/.test(value) ? sum + BigInt(value) : sum;
  }, 0n);
  return {
    confirmMs: {
      p50: percentile(durations, 50) ?? null,
      p95: percentile(durations, 95) ?? null,
      max: durations.length > 0 ? Math.max(...durations) : null,
    },
    feeWei: fee.toString(),
  };
}

/**
 * What only many transactions show, beyond the per-span checks: each sent hash is sent once and confirmed once, and
 * each confirm span links to the send span of its hash.
 */
export function loadFindings(spans: readonly ReadableSpan[], chainId: number): Finding[] {
  const findings: Finding[] = [];
  const sends = spans.filter((span) => span.name === `send ${chainId}`);
  const confirms = spans.filter((span) => span.name === `confirm ${chainId}`);
  const sendByHash = new Map<string, ReadableSpan>();
  for (const send of sends) {
    const hash = hashOf(send);
    if (!hash) continue;
    if (sendByHash.has(hash)) {
      findings.push({
        expectation: 'one send span per hash',
        message: `hash ${hash} has more than one`,
      });
    }
    sendByHash.set(hash, send);
  }
  const confirmed = new Set<string>();
  for (const confirm of confirms) {
    const hash = hashOf(confirm);
    if (!hash) continue;
    if (confirmed.has(hash)) {
      findings.push({
        expectation: 'one confirm span per hash',
        message: `hash ${hash} has more than one`,
      });
    }
    confirmed.add(hash);
    const send = sendByHash.get(hash);
    if (!send) {
      findings.push({
        expectation: 'confirm of a sent hash',
        message: `hash ${hash} was never sent`,
      });
      continue;
    }
    const sendId = send.spanContext().spanId;
    if (!confirm.links.some((link) => link.context.spanId === sendId)) {
      findings.push({
        expectation: 'confirm links to its send',
        message: `span ${confirm.spanContext().spanId} has no link to span ${sendId}`,
      });
    }
  }
  for (const hash of sendByHash.keys()) {
    if (!confirmed.has(hash)) {
      findings.push({
        expectation: 'every send confirmed',
        message: `hash ${hash} has no confirm span`,
      });
    }
  }
  return findings;
}

/** Histograms that record one value per transaction. */
export const PER_TRANSACTION_HISTOGRAMS = [
  'blockchain.client.send.duration',
  'blockchain.client.confirmation.duration',
  'blockchain.client.fee',
] as const;

/** How many values each histogram recorded, summed over its data points, from an in-memory exporter's batches. */
export function histogramCounts(batches: readonly ResourceMetrics[]): Map<string, number> {
  const counts = new Map<string, number>();
  // A cumulative exporter repeats the totals in each batch: the last batch holds them all.
  const last = batches.at(-1);
  for (const scope of last?.scopeMetrics ?? []) {
    for (const metric of scope.metrics) {
      const count = metric.dataPoints.reduce((sum, point) => {
        const value = point.value as { count?: unknown };
        return typeof value === 'object' && typeof value.count === 'number'
          ? sum + value.count
          : sum;
      }, 0);
      counts.set(metric.descriptor.name, (counts.get(metric.descriptor.name) ?? 0) + count);
    }
  }
  return counts;
}

/** A finding for each per-transaction histogram whose count is not `expected`. */
export function metricFindings(counts: ReadonlyMap<string, number>, expected: number): Finding[] {
  return PER_TRANSACTION_HISTOGRAMS.flatMap((name) => {
    const count = counts.get(name) ?? 0;
    return count === expected
      ? []
      : [
          {
            expectation: `${name} count`,
            message: `recorded ${count} value(s), expected ${expected}`,
          },
        ];
  });
}
