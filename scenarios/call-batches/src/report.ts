import { appendFileSync } from 'node:fs';
import { formatFindings } from '@hashspan-lab/common';
import type { BatchSummary } from './run.js';

/**
 * Prints the outcome, appends the summary as one JSON line to `RUN_SUMMARY_FILE` when it is set, and returns the
 * process exit code: 0 only when the run passed its span check.
 */
export function report(
  summary: BatchSummary,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  logError: (line: string) => void,
): number {
  if (summary.error) logError(`${summary.scenario}: ${summary.error}`);
  else if (summary.findings.length > 0) logError(formatFindings(summary.findings));
  else log(formatFindings(summary.findings));
  for (const line of summary.exportErrors) logError(`telemetry: ${line}`);
  const line = JSON.stringify(summary);
  log(line);
  if (env.RUN_SUMMARY_FILE) appendFileSync(env.RUN_SUMMARY_FILE, `${line}\n`);
  return summary.outcome === 'pass' ? 0 : 1;
}
