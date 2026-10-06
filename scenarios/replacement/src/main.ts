import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// A transaction can only be held pending on a chain that mines on command: this scenario runs on the local Anvil of
// `start:local` (`pnpm lab run replacement`), never on a public testnet.
if (process.env.REPLACEMENT_LOCAL !== '1') {
  console.error('replacement runs on a local Anvil only: use `pnpm lab run replacement`');
  process.exit(1);
}

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

const summary = await runScenario(telemetry, { env: process.env, log: console.log });
process.exitCode = report(summary, process.env, console.log, console.error);
