import { startTelemetry } from '@hashspan-lab/common';
import { report } from './report.js';
import { AGENT_NAME, runScenario } from './run.js';

// Base Sepolia, or whatever answers at BASE_SEPOLIA_RPC_URL with its chain id. No key: the scenario only reads.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const summary = await runScenario(telemetry, { env: process.env, log: console.log });
process.exitCode = report(summary, process.env, console.log, console.error);
