import { testnet } from '@hashspan-lab/common';
import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The scenario against a local Anvil that reports the chain id of LAB_TESTNET (Base Sepolia by default), with a fresh,
// funded key that is never written down. Telemetry goes wherever OTEL_EXPORTER_OTLP_ENDPOINT points (`make scenario-local` sets the stack).
const net = testnet(process.env.LAB_TESTNET);
const port = Number(process.env.LOCAL_ANVIL_PORT ?? 18546);
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port,
  chainId: net.chain.id,
});
await anvil.start();
try {
  const privateKey = generatePrivateKey();
  await createPublicClient({ transport: http(rpcUrl) }).request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
  });
  // The testnet's own variables, so the run reads them as it would on the testnet.
  const names = net.env;
  process.env[names.key] = privateKey;
  process.env[names.rpcUrl] = rpcUrl;
  // Anvil is not an OP-stack chain: its receipts carry no L1 data fee.
  process.env.EIP7702_OP_STACK = 'false';
  await import('./main.js');
} finally {
  await anvil.stop();
}
