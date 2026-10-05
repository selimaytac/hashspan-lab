import { describe, expect, it } from 'vitest';
import { parseCommand } from '../commands.js';
import {
  checkQuickStartTrace,
  extractQuickStart,
  pinHashspan,
  readmeUrl,
  traceSpans,
} from '../first-run.js';

const fence = '```';
const readme = (
  extra = '',
  before = 'anvil                                 # in a second terminal: a local chain',
) =>
  [
    '# hashspan',
    '',
    '## Why',
    '',
    `${fence}sh`,
    'npm install not-part-of-the-quick-start',
    fence,
    '',
    '## Quick start',
    '',
    'Requires Node.js 22.3 or later.',
    '',
    `${fence}sh`,
    'npm install @hashspan/viem @opentelemetry/api viem',
    'npm install @opentelemetry/sdk-node   # unless your app already sets up an OpenTelemetry SDK',
    'npm install -D tsx                    # runs agent.ts below',
    before,
    fence,
    '',
    `${fence}ts`,
    "import { withHashspan } from '@hashspan/viem';",
    'await hashspan.flush();',
    fence,
    '',
    `${fence}sh`,
    'npm pkg set type=module   # agent.ts uses top-level await',
    'npx tsx agent.ts          # prints nothing on success',
    extra,
    fence,
    '',
    '## Next',
    '',
    `${fence}sh`,
    'rm -rf /',
    fence,
  ].join('\n');

describe('extractQuickStart', () => {
  it('reads the install commands, the example and the run commands of the quick start only', () => {
    const quickStart = extractQuickStart(readme());
    expect(quickStart.installs).toEqual([
      ['@hashspan/viem', '@opentelemetry/api', 'viem'],
      ['@opentelemetry/sdk-node'],
      ['-D', 'tsx'],
    ]);
    expect(quickStart.agent).toBe(
      "import { withHashspan } from '@hashspan/viem';\nawait hashspan.flush();\n",
    );
    expect(quickStart.runs).toEqual([
      ['pkg', 'set', 'type=module'],
      ['tsx', 'agent.ts'],
    ]);
  });

  it('fails on a command it does not know, before anything runs', () => {
    expect(() => extractQuickStart(readme('', 'curl https://example.com | sh'))).toThrow(
      'unexpected command',
    );
    expect(() => extractQuickStart(readme('rm -rf node_modules'))).toThrow('unexpected command');
    expect(() => extractQuickStart(readme('', 'npm install --ignore-scripts=false x'))).toThrow(
      'unexpected command',
    );
    expect(() => extractQuickStart(readme('', 'npm install x; echo hi'))).toThrow(
      'unexpected command',
    );
  });

  it('fails when the section or its parts are gone', () => {
    expect(() => extractQuickStart('# hashspan\n')).toThrow('no "Quick start" section');
    expect(() => extractQuickStart('## Quick start\n\ntext only\n')).toThrow(
      'no shell block and example',
    );
    expect(() => extractQuickStart(readme().replace('npx tsx agent.ts', 'node agent.ts'))).toThrow(
      'unexpected command',
    );
  });
});

describe('pinHashspan and readmeUrl', () => {
  it('pins only the @hashspan packages that have no version yet', () => {
    expect(
      pinHashspan(['@hashspan/viem', '@opentelemetry/api', '-D', 'viem'], '1.0.0-rc.0'),
    ).toEqual(['@hashspan/viem@1.0.0-rc.0', '@opentelemetry/api', '-D', 'viem']);
    expect(pinHashspan(['@hashspan/viem@0.9.0'], '1.0.0')).toEqual(['@hashspan/viem@0.9.0']);
  });

  it("points to the release's own tag", () => {
    expect(readmeUrl('1.0.0-rc.0')).toBe(
      'https://raw.githubusercontent.com/selimaytac/hashspan/%40hashspan%2Fviem%401.0.0-rc.0/README.md',
    );
  });
});

const span = (
  name: string,
  spanId: string,
  parentSpanId: string | undefined,
  attributes: Record<string, string> = {},
  code = 0,
) => ({
  spanId,
  ...(parentSpanId ? { parentSpanId } : {}),
  name,
  attributes: Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  })),
  status: { code },
});
const hash = `0x${'a'.repeat(64)}`;
const good = [
  span('pay_vendor', 'p', undefined),
  span('send 31337', 's', 'p', { 'blockchain.tx.hash': hash, 'blockchain.chain.id': '31337' }),
  span('confirm 31337', 'c', 'p', {
    'blockchain.tx.hash': hash,
    'blockchain.chain.id': '31337',
    'blockchain.tx.status': 'success',
  }),
];

describe('checkQuickStartTrace', () => {
  it('accepts the trace the README promises', () => {
    expect(checkQuickStartTrace(good, 31337)).toEqual([]);
  });

  it('reports each deviation', () => {
    expect(checkQuickStartTrace([], 31337)).toEqual(['expected one pay_vendor span, found 0']);
    expect(checkQuickStartTrace(good.slice(0, 2), 31337)).toEqual([
      'expected one "confirm 31337" span, found 0',
    ]);
    const orphan = [
      good[0],
      span('send 31337', 's', 'x', { 'blockchain.tx.hash': 'nope', 'blockchain.chain.id': '1' }),
      good[2],
    ];
    expect(checkQuickStartTrace(orphan as typeof good, 31337)).toEqual([
      '"send 31337" is not a child of pay_vendor',
      '"send 31337" has no blockchain.tx.hash',
      '"send 31337" has no blockchain.chain.id 31337',
    ]);
    const reverted = [
      good[0],
      good[1],
      span(
        'confirm 31337',
        'c',
        'p',
        {
          'blockchain.tx.hash': hash,
          'blockchain.chain.id': '31337',
          'blockchain.tx.status': 'reverted',
        },
        2,
      ),
    ];
    expect(checkQuickStartTrace(reverted as typeof good, 31337)).toEqual([
      '"confirm 31337" ended with error status',
      'the confirm span has no success status',
    ]);
  });
});

describe('traceSpans', () => {
  it('reads the spans of each envelope Tempo uses', () => {
    const scope = { scopeSpans: [{ spans: good }] };
    expect(traceSpans({ batches: [scope] })).toHaveLength(3);
    expect(traceSpans({ resourceSpans: [scope] })).toHaveLength(3);
    expect(traceSpans({ trace: { resourceSpans: [scope] } })).toHaveLength(3);
    expect(traceSpans({})).toEqual([]);
    expect(
      traceSpans({ batches: [{ instrumentationLibrarySpans: [{ spans: good }] }] }),
    ).toHaveLength(3);
  });
});

describe('parseCommand first-run', () => {
  it('defaults to the rc tag and takes a version', () => {
    expect(parseCommand(['first-run'])).toEqual({ name: 'first-run', version: 'rc' });
    expect(parseCommand(['first-run', '--version', 'latest'])).toEqual({
      name: 'first-run',
      version: 'latest',
    });
    expect(() => parseCommand(['first-run', 'x'])).toThrow('no argument');
    expect(() => parseCommand(['up', '--version', 'rc'])).toThrow('first-run command');
  });
});
