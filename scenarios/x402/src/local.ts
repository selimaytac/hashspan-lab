import { startTelemetry } from '@hashspan-lab/common';
import { Instance } from 'prool';
import { generatePrivateKey } from 'viem/accounts';
import { AGENT_NAME } from './expectations.js';

// The scenario against a local Anvil that reports Base Sepolia's chain id, with a fresh key that holds only the
// local test token and is never written down; the SDK's facilitator settles in this process. Telemetry goes wherever
// OTEL_EXPORTER_OTLP_ENDPOINT points (`make scenario-local` sets the stack).
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { ANVIL_SETTLER, deployTestUsd } = await import('./local-chain.js');
const { localFacilitator } = await import('./local-facilitator.js');
const { NETWORK, PRICE, runScenario } = await import('./run.js');
const { report } = await import('./report.js');

const port = Number(process.env.LOCAL_ANVIL_PORT ?? 18546);
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port,
  chainId: 84532,
});
await anvil.start();
try {
  const privateKey = generatePrivateKey();
  const asset = await deployTestUsd(rpcUrl, privateKey, 10n * PRICE);
  const summary = await runScenario(telemetry, {
    env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: rpcUrl },
    log: console.log,
    facilitator: localFacilitator(rpcUrl, ANVIL_SETTLER, NETWORK),
    asset,
    // Anvil is not an OP-stack chain: its receipts carry no L1 data fee.
    opStack: false,
  });
  process.exitCode = report(summary, process.env, console.log, console.error);
} finally {
  await anvil.stop();
}
