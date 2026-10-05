/**
 * The semantic conventions as @hashspan/core exports them: `ATTR_*` are attribute keys, `METRIC_*` metric names and
 * `BLOCKCHAIN_<NAME>_VALUE_<VALUE>` the documented values of the attribute `ATTR_BLOCKCHAIN_<NAME>`. Reading them from
 * the package keeps the check in step with the release under test: nothing here is a copy of the documentation.
 */
export interface Contract {
  /** Attribute keys, such as `blockchain.tx.hash`. */
  attributes: Set<string>;
  /** Metric names, such as `blockchain.client.fee`. */
  metrics: Set<string>;
  /** Documented values of an attribute, for the attributes that have a closed set. */
  values: Map<string, Set<string>>;
}

export function readContract(core: Record<string, unknown>): Contract {
  const attributes = new Set<string>();
  const metrics = new Set<string>();
  const byConstant = new Map<string, string>();
  for (const [name, value] of Object.entries(core)) {
    if (typeof value !== 'string') continue;
    if (name.startsWith('ATTR_')) {
      attributes.add(value);
      byConstant.set(name, value);
    } else if (name.startsWith('METRIC_')) {
      metrics.add(value);
    }
  }
  const values = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(core)) {
    const match = /^BLOCKCHAIN_(.+)_VALUE_.+$/.exec(name);
    if (typeof value !== 'string' || !match) continue;
    const attribute = byConstant.get(`ATTR_BLOCKCHAIN_${match[1]}`);
    if (!attribute) continue;
    const set = values.get(attribute) ?? new Set<string>();
    set.add(value);
    values.set(attribute, set);
  }
  return { attributes, metrics, values };
}

/** The namespaces hashspan owns: an attribute or label in one of them must be in the contract. */
export const OWNED_ATTRIBUTE_PREFIXES = ['blockchain.', 'x402.'] as const;

/** An attribute key as a Prometheus label: dots become underscores. */
export const asLabel = (attribute: string): string => attribute.replaceAll('.', '_');

/** A metric name as Prometheus names it before the unit and type suffixes (`_seconds`, `_bucket`, ...). */
export const asMetricBase = (metric: string): string => metric.replaceAll('.', '_');
