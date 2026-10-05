import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { compareFees, type SealedReceipt } from '../src/compare.js';

const CHAIN = 84532;
const HASH = `0x${'ab'.repeat(32)}`;

/** A confirm span as the check reads it: a name and attributes. */
const confirm = (attributes: Record<string, string | number>, hash = HASH) =>
  ({
    name: `confirm ${CHAIN}`,
    attributes: { 'blockchain.tx.hash': hash, ...attributes },
  }) as unknown as ReadableSpan;

// 21 000 gas at 6 000 000 wei, plus an L1 fee of 5 950 506 538 wei (Base Sepolia, block 47589368).
const receipt: SealedReceipt = {
  transactionHash: HASH,
  status: '0x1',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x5b8d80',
  l1Fee: '0x162ad862a',
};
const sealed = new Map([[HASH, receipt]]);
const fee = (21_000n * 6_000_000n + 5_950_506_538n).toString();

describe('compareFees', () => {
  it('passes a span that carries the sealed receipt fees', () => {
    const check = compareFees(
      [
        confirm({
          'blockchain.tx.status': 'success',
          'blockchain.tx.l1_fee': '5950506538',
          'blockchain.tx.fee': fee,
        }),
      ],
      CHAIN,
      sealed,
    );
    expect(check).toEqual({ checked: 1, withoutFees: 0, findings: [] });
  });

  it("reports an L1 fee that is not the sealed receipt's, as a preconfirmation's can be (hashspan #179)", () => {
    const check = compareFees(
      [
        confirm({
          'blockchain.tx.status': 'success',
          'blockchain.tx.l1_fee': '11950753361',
          'blockchain.tx.fee': fee,
        }),
      ],
      CHAIN,
      sealed,
    );
    expect(check.findings.map((f) => f.message)).toEqual([
      'blockchain.tx.l1_fee is 11950753361, sealed receipt: 5950506538',
    ]);
  });

  it('reports a total fee and a status that do not match', () => {
    const check = compareFees(
      [
        confirm({
          'blockchain.tx.status': 'reverted',
          'blockchain.tx.l1_fee': '5950506538',
          'blockchain.tx.fee': '1',
        }),
      ],
      CHAIN,
      sealed,
    );
    expect(check.findings).toHaveLength(2);
  });

  it('computes the fee without an L1 part on a chain whose receipts have none', () => {
    const l2Less = new Map([[HASH, { ...receipt, l1Fee: null }]]);
    const check = compareFees(
      [
        confirm({
          'blockchain.tx.status': 'success',
          'blockchain.tx.fee': (21_000n * 6_000_000n).toString(),
        }),
      ],
      CHAIN,
      l2Less,
    );
    expect(check.findings).toEqual([]);
  });

  it('allows a few spans without fees, the documented fallback, but not many', () => {
    const many = Array.from({ length: 10 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`);
    const receipts = new Map(many.map((hash) => [hash, { ...receipt, transactionHash: hash }]));
    const spans = (withoutFees: number) =>
      many.map((hash, i) =>
        confirm(
          i < withoutFees
            ? { 'blockchain.tx.status': 'success' }
            : {
                'blockchain.tx.status': 'success',
                'blockchain.tx.l1_fee': '5950506538',
                'blockchain.tx.fee': fee,
              },
          hash,
        ),
      );
    expect(compareFees(spans(2), CHAIN, receipts).findings).toEqual([]);
    expect(compareFees(spans(3), CHAIN, receipts).findings).toHaveLength(1);
  });

  it('skips spans of other chains and hashes without a sealed receipt', () => {
    const other = {
      name: 'confirm 1',
      attributes: { 'blockchain.tx.hash': HASH },
    } as unknown as ReadableSpan;
    expect(compareFees([other, confirm({}, `0x${'cd'.repeat(32)}`)], CHAIN, sealed).checked).toBe(
      0,
    );
  });
});
