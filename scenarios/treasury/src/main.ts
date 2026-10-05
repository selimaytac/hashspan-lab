import { OpenTelemetry } from '@ai-sdk/otel';
import { startTelemetry } from '@hashspan-lab/common';
import { registerTelemetry } from 'ai';
import { AGENT_NAME } from './names.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
// The AI SDK emits GenAI spans (invoke_agent, execute_tool, ...) through the same provider.
registerTelemetry(new OpenTelemetry());

const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

const { testnet } = await import('@hashspan-lab/common');

// The testnet named by LAB_TESTNET (Base Sepolia by default), or whatever answers at its RPC URL variable with its
// chain id (a local Anvil in `start:local`, which also sets TREASURY_OP_STACK=false).
const summary = await runScenario(telemetry, {
  net: testnet(process.env.LAB_TESTNET),
  env: process.env,
  log: console.log,
  ...(process.env.TREASURY_OP_STACK === 'false' ? { opStack: false } : {}),
});
process.exitCode = report(summary, process.env, console.log, console.error);
