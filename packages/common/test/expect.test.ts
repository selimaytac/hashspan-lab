import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { checkSpans, formatFindings } from '../src/index.js';

/** A tool span with a send and a reverted confirm span under it, and a stray span in its own trace. */
function agentSpans(): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('test');
  const tool = tracer.startSpan('execute_tool withdraw');
  const inTool = trace.setSpan(context.active(), tool);
  tracer.startSpan('send 84532', { attributes: { 'blockchain.tx.hash': '0xabc' } }, inTool).end();
  tracer
    .startSpan(
      'confirm 84532',
      {
        attributes: {
          'blockchain.tx.status': 'reverted',
          'blockchain.tx.fee': '42',
          'blockchain.tx.revert.reason': 'WithdrawalLimitExceeded(1, 2)',
        },
      },
      inTool,
    )
    .end();
  tool.end();
  tracer.startSpan('send 84532', { attributes: { 'blockchain.tx.hash': '0xdef' } }).end();
  return exporter.getFinishedSpans();
}

describe('checkSpans', () => {
  it('returns no findings when every expectation is met', () => {
    expect(
      checkSpans(agentSpans(), [
        { name: 'send 84532', count: 2, attributes: { 'blockchain.tx.hash': /^0x/ } },
        {
          name: 'confirm 84532',
          count: 1,
          where: { 'blockchain.tx.status': 'reverted' },
          parent: /^execute_tool /,
          attributes: {
            'blockchain.tx.fee': { present: true },
            'blockchain.tx.revert.reason': 'WithdrawalLimitExceeded(1, 2)',
          },
        },
        { name: /^execute_tool / },
      ]),
    ).toEqual([]);
  });

  it('checks that a removed attribute is absent', () => {
    const spans = agentSpans();
    expect(
      checkSpans(spans, [
        { name: 'confirm 84532', attributes: { 'blockchain.removed': { absent: true } } },
      ]),
    ).toEqual([]);
    const findings = checkSpans(spans, [
      { name: 'confirm 84532', attributes: { 'blockchain.tx.status': { absent: true } } },
    ]);
    expect(findings.map((f) => f.message.replace(/[0-9a-f]{16}/g, '<id>'))).toEqual([
      'span <id>: blockchain.tx.status is recorded, expected to be absent',
    ]);
  });

  it('reports a missing span, a wrong count, a wrong parent, a missing attribute and another trace', () => {
    const findings = checkSpans(agentSpans(), [
      { name: 'payment 84532' },
      { name: 'confirm 84532', count: 2 },
      { name: 'send 84532', parent: 'execute_tool withdraw', sameTrace: true },
      { name: 'confirm 84532', attributes: { 'blockchain.tx.l1_fee': { present: true } } },
      { name: 'confirm 84532', attributes: { 'blockchain.tx.status': 'success' } },
      { name: 'confirm 84532', attributes: { 'blockchain.tx.fee': /^9/ } },
      { name: 'confirm 84532', where: { 'blockchain.tx.status': 'success' } },
    ]);
    expect(findings.map((f) => f.message.replace(/[0-9a-f]{16}/g, '<id>'))).toEqual([
      'found 0 span(s), expected at least 1',
      'found 1 span(s), expected 2',
      'span <id> has parent none, expected execute_tool withdraw',
      'span <id> is in another trace',
      'span <id>: blockchain.tx.l1_fee is missing',
      'span <id>: blockchain.tx.status is "reverted", expected "success"',
      'span <id>: blockchain.tx.fee is "42", expected to match /^9/',
      'found 0 span(s), expected at least 1',
    ]);
    expect(findings.at(-1)?.expectation).toBe(
      'confirm 84532 where {"blockchain.tx.status":"success"}',
    );
  });

  it('compares array attributes by their items', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider
      .getTracer('test')
      .startSpan('s', { attributes: { list: ['a', 'b'] } })
      .end();
    const spans = exporter.getFinishedSpans();
    expect(checkSpans(spans, [{ name: 's', attributes: { list: ['a', 'b'] } }])).toEqual([]);
    expect(checkSpans(spans, [{ name: 's', attributes: { list: ['a'] } }])).toHaveLength(1);
  });
});

describe('formatFindings', () => {
  it('lists the findings, or says that there are none', () => {
    expect(formatFindings([])).toBe('All span expectations were met.');
    expect(formatFindings([{ expectation: 'send 84532', message: 'found 0 span(s)' }])).toBe(
      '1 span expectation(s) not met:\n  - send 84532: found 0 span(s)',
    );
  });
});
