import type { Finding } from '@hashspan-lab/common';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/** The fields of a sealed receipt the check reads, as the node returns them (hex quantities). */
export interface SealedReceipt {
  transactionHash: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string | null;
  l1Fee?: string | null;
}

export interface FeeCheck {
  /** Confirm spans compared with a sealed receipt. */
  checked: number;
  /** Confirm spans recorded without fees, as @hashspan/viem does when no sealed receipt came in time. */
  withoutFees: number;
  findings: Finding[];
}

/** Share of spans that may be recorded without fees before it counts as a finding: a slow public RPC, not a bug. */
export const MAX_WITHOUT_FEES_SHARE = 0.2;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const quantity = (hex: string | null | undefined): bigint | undefined =>
  typeof hex === 'string' ? BigInt(hex) : undefined;

/**
 * Compares the confirm spans of the watched transactions with the sealed receipts of their blocks: status, L1 fee and
 * total fee must be the sealed receipt's, never a preconfirmation's (hashspan ADR 0024, hashspan #179). A span without
 * fees is allowed (the documented fallback when the sealed receipt does not come in time) unless too many are.
 */
export function compareFees(
  spans: readonly ReadableSpan[],
  chainId: number,
  sealed: ReadonlyMap<string, SealedReceipt>,
): FeeCheck {
  const findings: Finding[] = [];
  let checked = 0;
  let withoutFees = 0;
  for (const span of spans) {
    if (span.name !== `confirm ${chainId}`) continue;
    const hash = text(span.attributes['blockchain.tx.hash'])?.toLowerCase();
    const receipt = hash ? sealed.get(hash) : undefined;
    if (!hash || !receipt) continue;
    checked += 1;
    const report = (message: string) =>
      findings.push({ expectation: `confirm ${chainId} of ${hash}`, message });

    const status = receipt.status === '0x1' ? 'success' : 'reverted';
    if (span.attributes['blockchain.tx.status'] !== status) {
      report(
        `blockchain.tx.status is ${String(span.attributes['blockchain.tx.status'])}, sealed receipt: ${status}`,
      );
    }
    const fee = text(span.attributes['blockchain.tx.fee']);
    const l1Fee = text(span.attributes['blockchain.tx.l1_fee']);
    if (fee === undefined) {
      withoutFees += 1;
      if (l1Fee !== undefined) report('blockchain.tx.l1_fee is recorded without blockchain.tx.fee');
      continue;
    }
    const sealedL1Fee = quantity(receipt.l1Fee);
    const price = quantity(receipt.effectiveGasPrice);
    if (sealedL1Fee !== undefined && l1Fee !== sealedL1Fee.toString()) {
      report(`blockchain.tx.l1_fee is ${String(l1Fee)}, sealed receipt: ${sealedL1Fee}`);
    }
    if (price !== undefined) {
      const expected = BigInt(receipt.gasUsed) * price + (sealedL1Fee ?? 0n);
      if (fee !== expected.toString()) {
        report(`blockchain.tx.fee is ${fee}, sealed receipt: ${expected}`);
      }
    }
  }
  if (checked > 0 && withoutFees / checked > MAX_WITHOUT_FEES_SHARE) {
    findings.push({
      expectation: `confirm ${chainId}`,
      message: `${withoutFees} of ${checked} confirm spans have no fees (more than ${MAX_WITHOUT_FEES_SHARE * 100}%)`,
    });
  }
  return { checked, withoutFees, findings };
}
