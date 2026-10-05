import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// Base Sepolia, or whatever answers at BASE_SEPOLIA_RPC_URL with its chain id (a local Anvil in `start:local`).
const summary = await runScenario(telemetry, {
  env: process.env,
  log: console.log,
  opStack: process.env.PATHS_OP_STACK !== 'false',
});
process.exitCode = report(summary, process.env, console.log, console.error);
