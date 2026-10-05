import { startTelemetry, testnet } from '@hashspan-lab/common';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { transactionCount } from './load.js';

// Telemetry first, so that everything imported afterwards is traced. The in-memory reader beside the OTLP one gives
// the run its histogram counts; it exports at shutdown, like the OTLP reader.
const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const telemetry = startTelemetry({
  serviceName: 'soak-agent',
  metricReaders: [
    new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 3_600_000 }),
  ],
});
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// The testnet named by LAB_TESTNET (Base Sepolia by default), or a local Anvil with its chain id in `start:local`.
const summary = await runScenario(telemetry, {
  net: testnet(process.env.LAB_TESTNET),
  env: process.env,
  log: console.log,
  transactions: transactionCount(process.env.SOAK_TRANSACTIONS),
  metrics,
  ...(process.env.SOAK_OP_STACK === 'false' ? { opStack: false } : {}),
});
process.exitCode = report(summary, process.env, console.log, console.error);
