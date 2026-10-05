import type { ErrorKind, Finding } from '@hashspan-lab/common';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export type Outcome = 'pass' | 'fail' | 'error';

export interface TransactionSummary {
  tool: string | null;
  hash: string;
  status: string | null;
  sendMs: number | null;
  confirmMs: number | null;
  feeWei: string | null;
}

/** One line of the run ledger. Built from spans and constants only: never a key, an RPC URL or an address. */
export interface RunSummary {
  scenario: string;
  chainId: number;
  startedAt: string;
  outcome: Outcome;
  /** The setup error, as a safe message, when the outcome is `error`. */
  error: string | null;
  /** `setup` when the run stopped on a LabSetupError (no key, too little balance, another chain), else `unexpected`. */
  errorKind: ErrorKind | null;
  findings: Finding[];
  durationMs: number;
  transactions: TransactionSummary[];
  /** Sum of the transactions' fees in wei, as a decimal string. */
  feeWei: string;
  setupTxHashes: string[];
  /** Failed OTLP exports or shutdown steps; the in-process check does not depend on them. */
  exportErrors: string[];
}

const ms = (span: ReadableSpan): number =>
  Math.round(span.duration[0] * 1e3 + span.duration[1] / 1e6);

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The traced transactions of a run, in the order they were sent. */
export function transactionsOf(
  spans: readonly ReadableSpan[],
  chainId: number,
): TransactionSummary[] {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  const sends = spans
    .filter((span) => span.name === `send ${chainId}`)
    .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
  const confirms = spans.filter((span) => span.name === `confirm ${chainId}`);
  return sends.flatMap((send) => {
    const hash = text(send.attributes['blockchain.tx.hash']);
    if (!hash) return [];
    const parentId = send.parentSpanContext?.spanId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const confirm = confirms.find((span) => span.attributes['blockchain.tx.hash'] === hash);
    return [
      {
        tool: parent?.name.startsWith('execute_tool ')
          ? parent.name.slice('execute_tool '.length)
          : null,
        hash,
        status: text(confirm?.attributes['blockchain.tx.status']),
        sendMs: ms(send),
        confirmMs: confirm ? ms(confirm) : null,
        feeWei: text(confirm?.attributes['blockchain.tx.fee']),
      },
    ];
  });
}

export function runSummary(
  input: Omit<RunSummary, 'transactions' | 'feeWei'> & {
    spans: readonly ReadableSpan[];
  },
): RunSummary {
  const { spans, ...rest } = input;
  const transactions = transactionsOf(spans, input.chainId);
  const feeWei = transactions.reduce((sum, tx) => sum + BigInt(tx.feeWei ?? 0), 0n).toString();
  return { ...rest, transactions, feeWei };
}
