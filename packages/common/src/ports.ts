import { createServer } from 'node:net';

/** A TCP port that is free on 127.0.0.1 right now, for a test's own Anvil, so several checkouts can run at once. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port === undefined ? reject(new Error('no port')) : resolve(port)));
    });
  });
}
