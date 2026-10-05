import {
  checkSpans,
  type ErrorKind,
  errorKind,
  type LabTelemetry,
  safeErrorMessage,
  type Testnet,
} from '@hashspan-lab/common';
import { runAgent } from './agent.js';
import { type ChainOptions, hashspan, type TreasuryChain, treasuryChain } from './chain.js';
import { treasuryExpectations } from './expectations.js';
import { type RunSummary, runSummary } from './summary.js';

export interface ScenarioOptions extends ChainOptions {
  net: Testnet;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** See `ExpectationOptions.opStack`; the testnet's own value unless set (Anvil is never OP-stack). */
  opStack?: boolean;
}

/**
 * Runs the treasury scenario once and ends the telemetry: hashspan's flush, the in-process span check on the
 * snapshot, then the providers' shutdown. Never throws; the outcome is in the summary.
 */
export async function runScenario(
  telemetry: LabTelemetry,
  { net, env, log, opStack = net.opStack, ...chainOptions }: ScenarioOptions,
): Promise<RunSummary> {
  const startedAt = new Date();
  let error: string | null = null;
  let kind: ErrorKind | null = null;
  let chain: TreasuryChain | undefined;
  try {
    chain = await treasuryChain(net, env, log, chainOptions);
    const { text, toolResults } = await runAgent(chain);
    log(text);
    for (const { toolName, output } of toolResults) {
      const { hash, status } = (output ?? {}) as { hash?: unknown; status?: unknown };
      log(`${toolName}: ${String(status)} ${net.explorer}/tx/${String(hash)}`);
    }
  } catch (caught) {
    error = safeErrorMessage(caught);
    kind = errorKind(caught);
  }

  const { spans, errors } = await telemetry.finish(() => hashspan.flush());
  const findings = error
    ? []
    : checkSpans(spans, treasuryExpectations({ chainId: net.chain.id, opStack }));
  return runSummary({
    scenario: 'treasury',
    chainId: net.chain.id,
    startedAt: startedAt.toISOString(),
    outcome: error ? 'error' : findings.length > 0 ? 'fail' : 'pass',
    error,
    errorKind: kind,
    findings,
    durationMs: Date.now() - startedAt.getTime(),
    spans,
    setupTxHashes: chain?.setupHashes ?? [],
    exportErrors: errors,
  });
}
