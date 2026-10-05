import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { report } from '../src/report.js';
import { type RunSummary, runSummary, transactionsOf } from '../src/summary.js';

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

/** Two tool calls, each with a send and a confirm span, and a send whose confirmation never came. */
function spans() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('test');
  for (const [tool, hash, status, fee] of [
    ['pay_vendor', HASH_A, 'success', '100'],
    ['withdraw_from_vault', HASH_B, 'reverted', '250'],
  ] as const) {
    const span = tracer.startSpan(`execute_tool ${tool}`);
    const inTool = trace.setSpan(context.active(), span);
    tracer.startSpan('send 84532', { attributes: { 'blockchain.tx.hash': hash } }, inTool).end();
    tracer
      .startSpan(
        'confirm 84532',
        {
          attributes: {
            'blockchain.tx.hash': hash,
            'blockchain.tx.status': status,
            'blockchain.tx.fee': fee,
          },
        },
        inTool,
      )
      .end();
    span.end();
  }
  tracer
    .startSpan('send 84532', { attributes: { 'blockchain.tx.hash': `0x${'c'.repeat(64)}` } })
    .end();
  tracer.startSpan('send 84532').end();
  tracer.startSpan('send 1', { attributes: { 'blockchain.tx.hash': HASH_A } }).end();
  return exporter.getFinishedSpans();
}

describe('transactionsOf', () => {
  it('pairs each send with its confirmation and names the tool that sent it', () => {
    const txs = transactionsOf(spans(), 84532);
    expect(txs.map(({ tool, hash, status, feeWei }) => ({ tool, hash, status, feeWei }))).toEqual([
      { tool: 'pay_vendor', hash: HASH_A, status: 'success', feeWei: '100' },
      { tool: 'withdraw_from_vault', hash: HASH_B, status: 'reverted', feeWei: '250' },
      { tool: null, hash: `0x${'c'.repeat(64)}`, status: null, feeWei: null },
    ]);
    expect(txs[0]?.sendMs).toBeGreaterThanOrEqual(0);
    expect(txs[2]?.confirmMs).toBeNull();
  });
});

const base = {
  scenario: 'treasury',
  chainId: 84532,
  startedAt: '2026-10-02T00:00:00.000Z',
  error: null,
  errorKind: null,
  findings: [],
  durationMs: 1,
  setupTxHashes: [],
  exportErrors: [],
};

describe('runSummary', () => {
  it('adds the transactions and their total fee', () => {
    const summary = runSummary({ ...base, outcome: 'pass', spans: spans() });
    expect(summary.feeWei).toBe('350');
    expect(summary.transactions).toHaveLength(3);
  });
});

describe('report', () => {
  const summary = (outcome: RunSummary['outcome']): RunSummary =>
    runSummary({ ...base, outcome, spans: [] });

  it('returns 0 only for a passed run and appends one JSON line per run to RUN_SUMMARY_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'treasury-'));
    try {
      const file = join(dir, 'runs.jsonl');
      const out: string[] = [];
      const err: string[] = [];
      expect(
        report(
          summary('pass'),
          { RUN_SUMMARY_FILE: file },
          (l) => out.push(l),
          (l) => err.push(l),
        ),
      ).toBe(0);
      expect(
        report(
          {
            ...summary('fail'),
            findings: [{ expectation: 'send 84532', message: 'found 0 span(s)' }],
            exportErrors: ['trace export: x'],
          },
          { RUN_SUMMARY_FILE: file },
          (l) => out.push(l),
          (l) => err.push(l),
        ),
      ).toBe(1);
      expect(
        report(
          { ...summary('error'), error: 'BASE_SEPOLIA_PRIVATE_KEY is not set.' },
          {},
          () => {},
          (l) => err.push(l),
        ),
      ).toBe(1);
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      expect(lines.map((line) => (JSON.parse(line) as RunSummary).outcome)).toEqual([
        'pass',
        'fail',
      ]);
      expect(err).toEqual([
        '1 span expectation(s) not met:\n  - send 84532: found 0 span(s)',
        'telemetry: trace export: x',
        'treasury: BASE_SEPOLIA_PRIVATE_KEY is not set.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
