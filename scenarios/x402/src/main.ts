import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { HTTPFacilitatorClient } = await import('@x402/core/server');
const { BASE_SEPOLIA_USDC, runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// Base Sepolia's USDC through the public testnet facilitator (the SDK's default URL, no API key).
const summary = await runScenario(telemetry, {
  env: process.env,
  log: console.log,
  facilitator: new HTTPFacilitatorClient(),
  asset: BASE_SEPOLIA_USDC,
  opStack: true,
});
process.exitCode = report(summary, process.env, console.log, console.error);
