import { startTelemetry } from '@hashspan-lab/common';
import { AGENT_NAME } from './expectations.js';

// Telemetry first, so that everything imported afterwards is traced.
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { toCoinbaseSmartAccount } = await import('viem/account-abstraction');
const { createPublicClient, http } = await import('viem');
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

// Pimlico's public bundler (no API key, rate-limited per IP) and a Coinbase smart account (EntryPoint v0.6) owned by
// the lab account, which pays its own gas. Polling every 5 s keeps the run under the public endpoint's limit.
const bundlerUrl =
  process.env.USER_OPERATIONS_BUNDLER_URL || 'https://public.pimlico.io/v2/84532/rpc';
// The chain's fee estimate can sit at Pimlico's floor; its own `fast` price is accepted.
const bundlerRpc = createPublicClient({ transport: http(bundlerUrl) });
const estimateFeesPerGas = async () => {
  const { fast } = (await bundlerRpc.request({
    method: 'pimlico_getUserOperationGasPrice' as never,
  })) as { fast: { maxFeePerGas: string; maxPriorityFeePerGas: string } };
  return {
    maxFeePerGas: BigInt(fast.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(fast.maxPriorityFeePerGas),
  };
};
const summary = await runScenario(telemetry, {
  env: process.env,
  log: console.log,
  bundlerUrl,
  estimateFeesPerGas,
  topUpConfirmations: 2,
  smartAccount: (client, owner) =>
    toCoinbaseSmartAccount({ client, owners: [owner as never], version: '1.1' }),
  pollingInterval: 5_000,
});
process.exitCode = report(summary, process.env, console.log, console.error);
