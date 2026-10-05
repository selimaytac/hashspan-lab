import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { bundlerNames, hostedBundler } = await import('./bundlers.js');
const { toSimpleAccountV07 } = await import('./simple-account.js');
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// A SimpleAccount for EntryPoint v0.7 owned by the lab account, which pays its own gas, sends one operation through
// each hosted bundler (Pimlico's and Candide's public endpoints, no API key; USER_OPERATIONS_V07_BUNDLERS narrows the
// list by name). Polling every 5 s keeps the run under Pimlico's 20 requests a minute.
const summary = await runScenario(telemetry, {
  env: process.env,
  log: console.log,
  bundlers: () => bundlerNames(process.env).map(hostedBundler),
  smartAccount: (client, owner) => toSimpleAccountV07({ client, owner }),
  confirmations: 2,
  pollingInterval: 5_000,
});
process.exitCode = report(summary, process.env, console.log, console.error);
