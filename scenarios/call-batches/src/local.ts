import { Instance } from 'prool';
import { createPublicClient, http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The scenario against a local Anvil that reports Base Sepolia's chain id, with a fresh, funded key that is never
// written down. Telemetry goes wherever OTEL_EXPORTER_OTLP_ENDPOINT points (`make scenario-local` sets the stack).
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
  await createPublicClient({ transport: http(rpcUrl) }).request({
    method: 'anvil_setBalance' as never,
    params: [privateKeyToAccount(privateKey).address, numberToHex(parseEther('1'))] as never,
  });
  process.env.BASE_SEPOLIA_PRIVATE_KEY = privateKey;
  process.env.BASE_SEPOLIA_RPC_URL = rpcUrl;
  // Anvil is not an OP-stack chain: its receipts carry no L1 data fee.
  process.env.BATCHES_OP_STACK = 'false';
  await import('./main.js');
} finally {
  await anvil.stop();
}
