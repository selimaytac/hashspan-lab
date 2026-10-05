import { startTelemetry } from '@hashspan-lab/common';
import { Instance } from 'prool';
import type { Address } from 'viem';
import { AGENT_NAME } from './expectations.js';

// The scenario against a local Anvil that reports Base Sepolia's chain id and a local stand-in for the CDP API, with
// throwaway credentials; nothing leaves localhost. Telemetry goes wherever OTEL_EXPORTER_OTLP_ENDPOINT points
// (`make scenario-local` sets the stack).
process.env.DISABLE_CDP_USAGE_TRACKING = 'true';
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { installLocalSmartAccount, startLocalCdpApi, throwawayCredentials } = await import(
  './local-cdp-api.js'
);
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

/** Anvil's first account, unlocked on every Anvil: the CDP account of local runs. */
const ANVIL_ACCOUNT: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/** Anvil's second account: the bundler that puts each user operation into its own bundle transaction. */
const ANVIL_BUNDLER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** Where the test smart account is installed. */
const SMART_ACCOUNT: Address = '0x00000000000000000000000000000000000A11cE';
const port = Number(process.env.LOCAL_ANVIL_PORT ?? 18546);
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port,
  chainId: 84532,
});
await anvil.start();
await installLocalSmartAccount(rpcUrl, SMART_ACCOUNT);
const api = await startLocalCdpApi({
  rpcUrl,
  account: ANVIL_ACCOUNT,
  smartAccount: SMART_ACCOUNT,
  bundler: ANVIL_BUNDLER,
});
try {
  const { apiKeyId, apiKeySecret, walletSecret } = throwawayCredentials();
  const summary = await runScenario(telemetry, {
    env: {
      CDP_API_KEY_ID: apiKeyId,
      CDP_API_KEY_SECRET: apiKeySecret,
      CDP_WALLET_SECRET: walletSecret,
    },
    log: console.log,
    // Anvil is not an OP-stack chain: its receipts carry no L1 data fee.
    opStack: false,
    rpcUrl,
    basePath: api.basePath,
  });
  process.exitCode = report(summary, process.env, console.log, console.error);
} finally {
  await api.close();
  await anvil.stop();
}
