import { appendFileSync } from 'node:fs';
import { formatFindings } from '@hashspan-lab/common';
import type { RunSummary } from './summary.js';

/**
 * Prints the outcome, appends the summary as one JSON line to `RUN_SUMMARY_FILE` when it is set, and returns the
 * process exit code: 0 only when the run passed its span check.
 */
export function report(
  summary: RunSummary,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  logError: (line: string) => void,
): number {
  if (summary.error) logError(`treasury: ${summary.error}`);
  else if (summary.findings.length > 0) logError(formatFindings(summary.findings));
  else log(formatFindings(summary.findings));
  for (const line of summary.exportErrors) logError(`telemetry: ${line}`);
  const line = JSON.stringify(summary);
  log(line);
  if (env.RUN_SUMMARY_FILE) appendFileSync(env.RUN_SUMMARY_FILE, `${line}\n`);
  return summary.outcome === 'pass' ? 0 : 1;
}
