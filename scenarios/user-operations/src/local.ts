import {
  installLocalSmartAccount,
  localSmartAccount,
  startLocalBundler,
  startTelemetry,
} from '@hashspan-lab/common';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AGENT_NAME } from './expectations.js';

// The scenario against a local Anvil that reports Base Sepolia's chain id, with a fresh, funded key that is never
// written down, a stand-in EntryPoint and smart account, and a local bundler. Telemetry goes wherever
// OTEL_EXPORTER_OTLP_ENDPOINT points (`make scenario-local` sets the stack).
const telemetry = startTelemetry({ serviceName: AGENT_NAME });
const { runScenario } = await import('./run.js');
const { report } = await import('./report.js');

const port = Number(process.env.LOCAL_ANVIL_PORT ?? 18546);
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port,
  chainId: 84532,
});
await anvil.start();
// Anvil's second account sends the bundles.
const bundler = await startLocalBundler({
  rpcUrl,
  executor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  token: 'local-token',
});
try {
  const client = createPublicClient({ transport: http(rpcUrl) });
  await installLocalSmartAccount(client as never);
  const privateKey = generatePrivateKey();
  await client.request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
  });
  const summary = await runScenario(telemetry, {
    env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: rpcUrl },
    log: console.log,
    bundlerUrl: bundler.url,
    smartAccount: localSmartAccount,
    topUpConfirmations: 1,
  });
  process.exitCode = report(summary, process.env, console.log, console.error);
} finally {
  await bundler.close();
  await anvil.stop();
}
