import { startTelemetry, testnet } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// The testnet named by LAB_TESTNET (Base Sepolia by default), or a local Anvil with its chain id in `start:local`.
const summary = await runScenario(telemetry, {
  net: testnet(process.env.LAB_TESTNET),
  env: process.env,
  log: console.log,
  ...(process.env.EIP7702_OP_STACK === 'false' ? { opStack: false } : {}),
});
process.exitCode = report(summary, process.env, console.log, console.error);
