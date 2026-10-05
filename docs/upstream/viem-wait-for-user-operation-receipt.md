# Draft: wevm/viem issue

Not posted. Verified on viem 2.57.2 (latest release on 2026-10-02); the same code is on `main`.

## Title

`waitForUserOperationReceipt` never resolves after two concurrent waits for the same hash on one client

## Body

### Check existing issues

- [x] I checked there isn't already an issue for the bug I encountered.

### Viem Version

2.57.2

### Current Behavior

After two concurrent `waitForUserOperationReceipt` calls for the same hash on the same bundler client have both
resolved, a later `waitForUserOperationReceipt` for that hash on that client never resolves and sends no request.
Waits for other hashes on the same client still work.

### Expected Behavior

The later wait polls again (or resolves from the receipt), like the first ones.

### Steps To Reproduce

```ts
import { custom } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { foundry } from 'viem/chains'

const hash = `0x${'12'.repeat(32)}` as const
const receipt = {
  userOpHash: hash,
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  sender: `0x${'11'.repeat(20)}`,
  nonce: '0x0',
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
}
let requests = 0
const client = createBundlerClient({
  chain: foundry,
  pollingInterval: 50,
  transport: custom({
    async request({ method }) {
      requests++
      if (method === 'eth_getUserOperationReceipt') return receipt
      throw new Error(`unexpected ${method}`)
    },
  }),
})

await Promise.all([
  client.waitForUserOperationReceipt({ hash }),
  client.waitForUserOperationReceipt({ hash }),
]) // both resolve

await client.waitForUserOperationReceipt({ hash }) // never resolves; `requests` stays 1
```

### Cause

In `account-abstraction/actions/bundler/waitForUserOperationReceipt.ts`, `done()` calls the `unobserve` of the
caller that started the poll (the first `observe()` call for the observer id). The second caller's listener was
added to `listenersCache` by its own `observe()` call, but nothing removes it after `emit.resolve(...)`. The next
`observe()` with the same id (`['waitForUserOperationReceipt', client.uid, hash]`) finds that stale listener, returns
early without running the poll function, and its promise is never settled.

Possible fix: have every caller unsubscribe when its own promise settles (wrap `resolve`/`reject` passed to
`observe()` so they call that caller's `unobserve`), or clear all listeners of the observer id in `done()`.
