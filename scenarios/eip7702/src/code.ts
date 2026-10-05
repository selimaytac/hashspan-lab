/**
 * Reads an account's code until `matches` accepts it or `attempts` reads were made, `delayMs` apart, and returns the
 * last code read (lower case, `0x` for none). A public RPC balances requests over nodes: right after a receipt, the
 * node that answers may not have the block yet, and a read at the receipt's block number can fail with "resource not
 * found". Reading the latest state again until it shows the change avoids both; a read that fails counts as an
 * attempt, and the last failure is thrown when no read succeeded.
 */
export async function readCodeUntil(
  read: () => Promise<string | undefined>,
  matches: (code: string) => boolean,
  attempts = 10,
  delayMs = 1_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  let last: string | undefined;
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = ((await read()) ?? '0x').toLowerCase();
      if (matches(last)) return last;
    } catch (caught) {
      failure = caught;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (last === undefined) throw failure;
  return last;
}
