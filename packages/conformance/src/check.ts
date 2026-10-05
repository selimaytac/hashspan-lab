import { asLabel, asMetricBase, type Contract, OWNED_ATTRIBUTE_PREFIXES } from './contract.js';

export interface Observed {
  /** Span attribute keys seen in Tempo. */
  spanAttributes: readonly string[];
  /** For each attribute with a documented set of values: the values seen. */
  spanValues: ReadonlyMap<string, readonly string[]>;
  /** Metric names seen in Prometheus that start with `blockchain_`. */
  metricNames: readonly string[];
  /** Label names seen on those metrics. */
  metricLabels: readonly string[];
}

export interface Report {
  /** What breaks the contract. Empty means conformant. */
  violations: string[];
  /** Documented attributes that some span carried, and those that none did. */
  coverage: { seen: string[]; unseen: string[] };
  /** Documented metrics with and without any series. */
  metrics: { seen: string[]; unseen: string[] };
}

const owned = (key: string): boolean =>
  OWNED_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));

export function check(contract: Contract, observed: Observed): Report {
  const violations: string[] = [];
  const seenAttributes = new Set(observed.spanAttributes);

  for (const key of [...seenAttributes].filter(owned).sort()) {
    if (!contract.attributes.has(key))
      violations.push(`span attribute ${key} is not in the semantic conventions`);
  }
  for (const [attribute, allowed] of contract.values) {
    for (const value of [...(observed.spanValues.get(attribute) ?? [])].sort()) {
      if (!allowed.has(value))
        violations.push(
          `${attribute} has the value ${JSON.stringify(value)}, not one of ${[...allowed].sort().join(', ')}`,
        );
    }
  }

  const bases = [...contract.metrics].map(asMetricBase);
  for (const name of [...observed.metricNames].sort()) {
    if (!bases.some((base) => name === base || name.startsWith(`${base}_`))) {
      violations.push(`metric ${name} is not one of ${[...contract.metrics].sort().join(', ')}`);
    }
  }
  const labels = new Set([...contract.attributes].map(asLabel));
  for (const label of [...new Set(observed.metricLabels)].sort()) {
    if (owned(label.replace('_', '.')) && !labels.has(label)) {
      violations.push(`metric label ${label} is not an attribute of the semantic conventions`);
    }
  }

  // An attribute is exercised when a span carried it, or when it came out as a label of a metric (some attributes are
  // documented for metrics only).
  const labelSet = new Set(observed.metricLabels);
  for (const attribute of contract.attributes)
    if (labelSet.has(asLabel(attribute))) seenAttributes.add(attribute);
  const documented = [...contract.attributes].sort();
  const metricsSeen = [...contract.metrics].filter((metric) =>
    observed.metricNames.some(
      (name) => name === asMetricBase(metric) || name.startsWith(`${asMetricBase(metric)}_`),
    ),
  );
  return {
    violations,
    coverage: {
      seen: documented.filter((key) => seenAttributes.has(key)),
      unseen: documented.filter((key) => !seenAttributes.has(key)),
    },
    metrics: {
      seen: metricsSeen.sort(),
      unseen: [...contract.metrics].filter((metric) => !metricsSeen.includes(metric)).sort(),
    },
  };
}

export function formatReport(report: Report): string {
  const total = report.coverage.seen.length + report.coverage.unseen.length;
  const lines = [
    `attributes: ${report.coverage.seen.length} of ${total} documented attributes were recorded (on a span or as a metric label)`,
    `metrics: ${report.metrics.seen.length} of ${report.metrics.seen.length + report.metrics.unseen.length} documented metrics have series`,
  ];
  if (report.coverage.unseen.length > 0)
    lines.push(`not exercised by any scenario: ${report.coverage.unseen.join(', ')}`);
  if (report.metrics.unseen.length > 0)
    lines.push(`metrics without series: ${report.metrics.unseen.join(', ')}`);
  lines.push(
    report.violations.length === 0
      ? 'conformant: nothing outside the semantic conventions was recorded'
      : `${report.violations.length} violation(s):`,
  );
  for (const violation of report.violations) lines.push(`  - ${violation}`);
  return lines.join('\n');
}
