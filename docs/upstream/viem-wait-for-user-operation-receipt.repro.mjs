import { custom } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { foundry } from 'viem/chains';

const hash = `0x${'12'.repeat(32)}`;
const receipt = {
  userOpHash: hash,
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  sender: `0x${'11'.repeat(20)}`,
  nonce: '0x0',
  paymaster: undefined,
  actualGasCost: '0x1',
  actualGasUsed: '0x1',
  success: true,
  logs: [],
  receipt: {
    transactionHash: `0x${'34'.repeat(32)}`,
    blockHash: `0x${'56'.repeat(32)}`,
    blockNumber: '0x1',
    from: `0x${'22'.repeat(20)}`,
    to: null,
    cumulativeGasUsed: '0x1',
    gasUsed: '0x1',
    effectiveGasPrice: '0x1',
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    transactionIndex: '0x0',
    type: '0x2',
    contractAddress: null,
  },
};
let calls = 0;
const transport = custom({
  async request({ method }) {
    calls++;
    if (method === 'eth_getUserOperationReceipt') return receipt;
    if (method === 'eth_chainId') return '0x7a69';
    throw new Error(`unexpected ${method}`);
  },
});
const client = createBundlerClient({ chain: foundry, transport, pollingInterval: 50 });
const timeout = (ms) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms));
const both = await Promise.all([
  client.waitForUserOperationReceipt({ hash }),
  client.waitForUserOperationReceipt({ hash }),
]);
console.log('two concurrent waits resolved:', both.length);
try {
  const third = await Promise.race([client.waitForUserOperationReceipt({ hash }), timeout(3000)]);
  console.log('third wait resolved:', third.userOpHash === hash);
} catch (e) {
  console.log('third wait:', e.message, '| requests made:', calls);
}
const fresh = await Promise.race([
  client
    .waitForUserOperationReceipt({ hash: `0x${'99'.repeat(32)}` })
    .catch(() => 'other-hash-done'),
  timeout(1000),
]).catch((e) => e.message);
console.log('other hash on same client:', typeof fresh === 'string' ? fresh : 'resolved');
process.exit(0);
