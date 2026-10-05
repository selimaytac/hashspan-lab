import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// The CDP SDK's usage tracking and error reporting stay off: the lab sends nothing to CDP but its own calls.
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';
// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// The CDP API and Base Sepolia; the reader uses BASE_SEPOLIA_RPC_URL when set.
const summary = await runScenario(telemetry, {
  env: process.env,
  log: console.log,
  opStack: true,
  ...(process.env.BASE_SEPOLIA_RPC_URL ? { rpcUrl: process.env.BASE_SEPOLIA_RPC_URL } : {}),
});
process.exitCode = report(summary, process.env, console.log, console.error);
