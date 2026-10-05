/**
 * `pnpm --filter ./packages/conformance start [--since <seconds>]` (or `pnpm lab conformance`): checks the span
 * attributes in Tempo and the metrics in Prometheus of the last `since` seconds (default one hour) against the semantic
 * conventions @hashspan/core exports. Exits 1 on a violation, or when a documented metric has no series at all.
 */
import { parseArgs } from 'node:util';
import * as core from '@hashspan/core';
import { check, formatReport, type Observed } from './check.js';
import { readContract } from './contract.js';

const TEMPO = process.env.LAB_TEMPO ?? 'http://127.0.0.1:13200';
const PROMETHEUS = process.env.LAB_PROMETHEUS ?? 'http://127.0.0.1:19090';

const { values } = parseArgs({ options: { since: { type: 'string', default: '3600' } } });
const since = Number(values.since);
if (!Number.isInteger(since) || since <= 0) {
  console.error('usage: conformance [--since <seconds>]');
  process.exit(2);
}

async function get<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error(`${new URL(url).origin} did not answer: is the lab stack up (pnpm lab up)?`);
  }
  if (!response.ok)
    throw new Error(
      `${new URL(url).origin} answered ${response.status} for ${new URL(url).pathname}`,
    );
  return (await response.json()) as T;
}

async function observe(attributesWithValueSets: Iterable<string>): Promise<Observed> {
  const end = Math.floor(Date.now() / 1000);
  const window = `start=${end - since}&end=${end}`;
  const tags = await get<{ scopes?: { tags?: string[] }[] }>(
    `${TEMPO}/api/v2/search/tags?scope=span&${window}`,
  );
  const spanAttributes = (tags.scopes ?? []).flatMap((scope) => scope.tags ?? []);

  const spanValues = new Map<string, string[]>();
  for (const attribute of attributesWithValueSets) {
    if (!spanAttributes.includes(attribute)) continue;
    const answer = await get<{ tagValues?: { value: string }[] }>(
      `${TEMPO}/api/v2/search/tag/span.${encodeURIComponent(attribute)}/values?${window}`,
    );
    spanValues.set(
      attribute,
      (answer.tagValues ?? []).map((entry) => String(entry.value)),
    );
  }

  const match = encodeURIComponent('{__name__=~"blockchain_.*"}');
  const names = await get<{ data?: string[] }>(
    `${PROMETHEUS}/api/v1/label/__name__/values?match[]=${match}`,
  );
  const labels = await get<{ data?: string[] }>(`${PROMETHEUS}/api/v1/labels?match[]=${match}`);
  return {
    spanAttributes,
    spanValues,
    metricNames: names.data ?? [],
    metricLabels: labels.data ?? [],
  };
}

try {
  const contract = readContract(core as unknown as Record<string, unknown>);
  const observed = await observe(contract.values.keys());
  const report = check(contract, observed);
  console.log(`last ${since} s, @hashspan/core ${core.VERSION ?? ''}`.trim());
  console.log(formatReport(report));
  const metricsMissing = report.metrics.unseen.length > 0 && observed.metricNames.length > 0;
  if (metricsMissing)
    console.error(`documented metrics without series: ${report.metrics.unseen.join(', ')}`);
  process.exit(report.violations.length > 0 || metricsMissing ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
