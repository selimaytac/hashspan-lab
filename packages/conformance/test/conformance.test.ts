import * as core from '@hashspan/core';
import { describe, expect, it } from 'vitest';
import { check, formatReport, type Observed } from '../src/check.js';
import { asLabel, asMetricBase, readContract } from '../src/contract.js';

const fakeCore = {
  ATTR_BLOCKCHAIN_TX_HASH: 'blockchain.tx.hash',
  ATTR_BLOCKCHAIN_TX_STATUS: 'blockchain.tx.status',
  ATTR_BLOCKCHAIN_TX_L1_FEE: 'blockchain.tx.l1_fee',
  ATTR_X402_RESOURCE: 'x402.resource',
  ATTR_ERROR_TYPE: 'error.type',
  METRIC_BLOCKCHAIN_CLIENT_FEE: 'blockchain.client.fee',
  METRIC_BLOCKCHAIN_CLIENT_SEND_DURATION: 'blockchain.client.send.duration',
  BLOCKCHAIN_TX_STATUS_VALUE_SUCCESS: 'success',
  BLOCKCHAIN_TX_STATUS_VALUE_REVERTED: 'reverted',
  BLOCKCHAIN_ORPHAN_VALUE_X: 'x', // no ATTR_BLOCKCHAIN_ORPHAN: ignored
  createTxTracker: () => undefined,
  SOMETHING: 42,
};

const contract = readContract(fakeCore);
const observed = (overrides: Partial<Observed> = {}): Observed => ({
  spanAttributes: [
    'blockchain.tx.hash',
    'blockchain.tx.status',
    'gen_ai.agent.name',
    'http.method',
  ],
  spanValues: new Map([['blockchain.tx.status', ['success', 'reverted']]]),
  metricNames: ['blockchain_client_fee_bucket', 'blockchain_client_send_duration_seconds_count'],
  metricLabels: ['blockchain_tx_status', 'job', 'le', 'error_type'],
  ...overrides,
});

describe('readContract', () => {
  it('reads attributes, metrics and closed value sets from the exports', () => {
    expect([...contract.attributes].sort()).toEqual([
      'blockchain.tx.hash',
      'blockchain.tx.l1_fee',
      'blockchain.tx.status',
      'error.type',
      'x402.resource',
    ]);
    expect([...contract.metrics].sort()).toEqual([
      'blockchain.client.fee',
      'blockchain.client.send.duration',
    ]);
    expect([...(contract.values.get('blockchain.tx.status') ?? [])].sort()).toEqual([
      'reverted',
      'success',
    ]);
    expect(contract.values.has('blockchain.orphan')).toBe(false);
  });

  it('names labels and metric bases the way Prometheus does', () => {
    expect(asLabel('blockchain.tx.l1_fee')).toBe('blockchain_tx_l1_fee');
    expect(asMetricBase('blockchain.client.send.duration')).toBe('blockchain_client_send_duration');
  });
});

describe('check', () => {
  it('passes when everything recorded is documented, and reports what no scenario exercised', () => {
    const report = check(contract, observed());
    expect(report.violations).toEqual([]);
    expect(report.coverage.seen).toEqual([
      'blockchain.tx.hash',
      'blockchain.tx.status',
      'error.type',
    ]);
    expect(report.coverage.unseen).toEqual(['blockchain.tx.l1_fee', 'x402.resource']);
    expect(report.metrics).toEqual({
      seen: ['blockchain.client.fee', 'blockchain.client.send.duration'],
      unseen: [],
    });
  });

  it('counts an attribute that came out as a metric label as exercised', () => {
    const report = check(contract, observed({ metricLabels: ['blockchain_tx_l1_fee', 'job'] }));
    expect(report.coverage.seen).toContain('blockchain.tx.l1_fee');
    expect(report.coverage.unseen).not.toContain('blockchain.tx.l1_fee');
  });

  it('ignores attributes outside the namespaces hashspan owns', () => {
    expect(
      check(contract, observed({ spanAttributes: ['http.method', 'gen_ai.whatever', 'db.system'] }))
        .violations,
    ).toEqual([]);
  });

  it('reports an attribute of an owned namespace that the conventions do not have (a removed or stray one)', () => {
    const report = check(
      contract,
      observed({ spanAttributes: ['blockchain.system', 'x402.invented', 'blockchain.tx.hash'] }),
    );
    expect(report.violations).toEqual([
      'span attribute blockchain.system is not in the semantic conventions',
      'span attribute x402.invented is not in the semantic conventions',
    ]);
  });

  it('reports a value outside the closed set of an attribute', () => {
    const report = check(
      contract,
      observed({ spanValues: new Map([['blockchain.tx.status', ['success', 'timeout']]]) }),
    );
    expect(report.violations).toEqual([
      'blockchain.tx.status has the value "timeout", not one of reverted, success',
    ]);
  });

  it('reports a metric and a label that are not documented', () => {
    const report = check(
      contract,
      observed({
        metricNames: ['blockchain_client_fee_count', 'blockchain_client_surprise_total'],
        metricLabels: ['blockchain_system', 'blockchain_tx_status', 'x402_resource', 'x402_nope'],
      }),
    );
    expect(report.violations).toEqual([
      'metric blockchain_client_surprise_total is not one of blockchain.client.fee, blockchain.client.send.duration',
      'metric label blockchain_system is not an attribute of the semantic conventions',
      'metric label x402_nope is not an attribute of the semantic conventions',
    ]);
    expect(report.metrics.unseen).toEqual(['blockchain.client.send.duration']);
  });

  it('does not take a longer name for a documented metric', () => {
    const report = check(contract, observed({ metricNames: ['blockchain_client_feeders_count'] }));
    expect(report.violations).toHaveLength(1);
  });
});

describe('formatReport', () => {
  it('summarises coverage and violations', () => {
    const text = formatReport(
      check(contract, observed({ spanAttributes: ['blockchain.system'], metricLabels: [] })),
    );
    expect(text).toContain('0 of 5 documented attributes were recorded');
    expect(text).toContain('1 violation(s):');
    expect(text).toContain('blockchain.system is not in the semantic conventions');
    expect(formatReport(check(contract, observed()))).toContain('conformant');
  });
});

describe('the contract of the release under test', () => {
  const real = readContract(core as unknown as Record<string, unknown>);

  it('is read from @hashspan/core and has the documented shape', () => {
    expect(real.attributes.size).toBeGreaterThan(40);
    expect(real.attributes.has('blockchain.tx.hash')).toBe(true);
    expect(real.attributes.has('blockchain.system.name')).toBe(true);
    expect(real.metrics.size).toBe(3);
  });

  it('no longer has the attribute removed in 1.0', () => {
    expect(real.attributes.has('blockchain.system')).toBe(false);
  });

  it('has closed value sets for the status attributes', () => {
    expect([...(real.values.get('blockchain.tx.status') ?? [])]).toEqual(
      expect.arrayContaining(['success', 'reverted']),
    );
  });
});
