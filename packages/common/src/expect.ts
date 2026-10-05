import type { AttributeValue } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * What a span's attribute must be: an exact value, a pattern for strings, `present` for any value, or `absent` for no
 * value at all (an attribute that was removed).
 */
export type AttributeExpectation = AttributeValue | RegExp | { present: true } | { absent: true };

export interface SpanExpectation {
  /** Span name, exactly or as a pattern. */
  name: string | RegExp;
  /** How many spans must match `name` and `where`; default: at least one. */
  count?: number;
  /** Only spans with these attribute values are counted and checked; e.g. `{ 'blockchain.tx.status': 'reverted' }`. */
  where?: Record<string, AttributeValue>;
  /** Name of the parent span, exactly or as a pattern; every matching span must have such a parent. */
  parent?: string | RegExp;
  /** Attributes every matching span must carry. */
  attributes?: Record<string, AttributeExpectation>;
  /** Every matching span must be in the trace of the first span of this expectation set. */
  sameTrace?: boolean;
}

/** A deviation from the expected telemetry. */
export interface Finding {
  expectation: string;
  message: string;
}

const describeName = (name: string | RegExp): string =>
  typeof name === 'string' ? name : name.toString();

const matches = (pattern: string | RegExp, value: string): boolean =>
  typeof pattern === 'string' ? pattern === value : pattern.test(value);

const sameValue = (a: AttributeValue | undefined, b: AttributeValue): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, i) => item === b[i])
    : a === b;

function attributeProblem(
  actual: AttributeValue | undefined,
  expected: AttributeExpectation,
): string | undefined {
  if (typeof expected === 'object' && expected !== null && 'absent' in expected) {
    return actual === undefined ? undefined : 'is recorded, expected to be absent';
  }
  if (actual === undefined) return 'is missing';
  if (expected instanceof RegExp) {
    return typeof actual === 'string' && expected.test(actual)
      ? undefined
      : `is ${JSON.stringify(actual)}, expected to match ${expected}`;
  }
  if (typeof expected === 'object' && expected !== null && 'present' in expected) return undefined;
  return sameValue(actual, expected)
    ? undefined
    : `is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

/** Checks `spans` against every expectation and returns what deviates; an empty list means all were met. */
export function checkSpans(
  spans: readonly ReadableSpan[],
  expectations: readonly SpanExpectation[],
): Finding[] {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  const findings: Finding[] = [];
  let traceId: string | undefined;

  for (const expectation of expectations) {
    const label = `${describeName(expectation.name)}${
      expectation.where ? ` where ${JSON.stringify(expectation.where)}` : ''
    }`;
    const report = (message: string) => findings.push({ expectation: label, message });
    const matching = spans.filter(
      (span) =>
        matches(expectation.name, span.name) &&
        Object.entries(expectation.where ?? {}).every(([key, value]) =>
          sameValue(span.attributes[key], value),
        ),
    );

    if (
      expectation.count === undefined
        ? matching.length === 0
        : matching.length !== expectation.count
    ) {
      report(`found ${matching.length} span(s), expected ${expectation.count ?? 'at least 1'}`);
    }

    for (const span of matching) {
      const id = span.spanContext().spanId;
      if (expectation.parent !== undefined) {
        const parentId = span.parentSpanContext?.spanId;
        const parent = parentId ? byId.get(parentId) : undefined;
        if (!parent || !matches(expectation.parent, parent.name)) {
          report(
            `span ${id} has parent ${parent ? JSON.stringify(parent.name) : 'none'}, expected ${describeName(expectation.parent)}`,
          );
        }
      }
      for (const [key, expected] of Object.entries(expectation.attributes ?? {})) {
        const problem = attributeProblem(span.attributes[key], expected);
        if (problem) report(`span ${id}: ${key} ${problem}`);
      }
      if (expectation.sameTrace) {
        traceId ??= span.spanContext().traceId;
        if (span.spanContext().traceId !== traceId) report(`span ${id} is in another trace`);
      }
    }
  }
  return findings;
}

/** Findings as lines that are safe to print: span names, ids and attribute values only. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'All span expectations were met.';
  return [
    `${findings.length} span expectation(s) not met:`,
    ...findings.map(({ expectation, message }) => `  - ${expectation}: ${message}`),
  ].join('\n');
}
