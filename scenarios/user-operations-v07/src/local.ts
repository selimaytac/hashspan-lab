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

/** Nobody's address: the stand-in EntryPoint does not run a paymaster, it only reports the one in the operation. */
const LOCAL_PAYMASTER = '0x000000000000000000000000000000000000a1ce';

// The scenario against a local Anvil that reports Base Sepolia's chain id, with a fresh, funded key that is never
// written down, the stand-in EntryPoint v0.7 and test account, and two local bundlers named like the hosted ones.
// Telemetry goes wherever OTEL_EXPORTER_OTLP_ENDPOINT points (`make scenario-local` sets the stack).
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
// Anvil's second account sends the bundles of both.
const executor = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const first = await startLocalBundler({ rpcUrl, executor, token: 'local-token-1' });
const second = await startLocalBundler({ rpcUrl, executor, token: 'local-token-2' });
try {
  const client = createPublicClient({ transport: http(rpcUrl) });
  await installLocalSmartAccount(client);
  const privateKey = generatePrivateKey();
  await client.request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
  });
  const summary = await runScenario(telemetry, {
    env: { BASE_SEPOLIA_PRIVATE_KEY: privateKey, BASE_SEPOLIA_RPC_URL: rpcUrl },
    log: console.log,
    bundlers: () => [
      { name: 'pimlico', url: first.url },
      { name: 'candide', url: second.url },
      // A paymaster pays for this one: the stand-in EntryPoint reports it in the event (a local run only).
      { name: 'sponsored', url: first.url, paymaster: LOCAL_PAYMASTER },
    ],
    smartAccount: localSmartAccount,
    confirmations: 1,
  });
  process.exitCode = report(summary, process.env, console.log, console.error);
} finally {
  await first.close();
  await second.close();
  await anvil.stop();
}
