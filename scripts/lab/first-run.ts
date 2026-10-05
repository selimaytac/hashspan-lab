/**
 * The first-run scenario: what a new user does with the PUBLISHED packages. It takes the quick start of hashspan's
 * README at the release's own tag, installs the packages from the npm registry into an empty project outside this
 * workspace, saves the example as `agent.ts`, runs it against a local Anvil, and checks in Tempo that the trace the
 * README promises is there. The pure parts live here; `pnpm lab first-run` runs them (scripts/lab.ts).
 */

export interface QuickStart {
  /** The `npm install` commands, as argument lists without `npm install`. */
  installs: string[][];
  /** The example, to be saved as agent.ts. */
  agent: string;
  /** The commands after the example, as argument lists. */
  runs: string[][];
}

interface Block {
  lang: string;
  lines: string[];
}

/** The fenced code blocks of the section named `heading`, in order. */
function sectionBlocks(markdown: string, heading: string): Block[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`the README has no "${heading}" section`);
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const line of lines.slice(start + 1)) {
    if (!current && line.startsWith('## ')) break;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (current) {
        blocks.push(current);
        current = undefined;
      } else {
        current = { lang: fence[1] ?? '', lines: [] };
      }
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

/** A shell line without its trailing `# comment`, as words. Empty for a blank line. */
function words(line: string): string[] {
  return line
    .replace(/\s+#.*$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const PACKAGE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;

/**
 * The quick start of `markdown`: the shell block before the example (install commands; `anvil` is started by the
 * lab), the example, and the shell block after it. A command it does not know fails the parse: the README changed,
 * and the lab must be taught about it before it runs anything. Commands come from the network, so only these shapes
 * are ever run: `npm install [-D] <package>...`, `npm pkg set type=module` and `npx tsx agent.ts`.
 */
export function extractQuickStart(markdown: string): QuickStart {
  const blocks = sectionBlocks(markdown, 'Quick start');
  const first = blocks.find((block) => block.lang === 'sh');
  const agentBlock = blocks.find((block) => block.lang === 'ts');
  if (!first || !agentBlock) throw new Error('the quick start has no shell block and example');
  const after = blocks.slice(blocks.indexOf(agentBlock) + 1).find((block) => block.lang === 'sh');

  const installs: string[][] = [];
  for (const line of first.lines) {
    const w = words(line);
    if (w.length === 0 || w[0] === 'anvil') continue;
    const [npm, install, ...args] = w;
    const flagsOk = args.every((arg) => arg === '-D' || PACKAGE.test(arg));
    if (npm !== 'npm' || install !== 'install' || !flagsOk) {
      throw new Error(
        `unexpected command in the quick start: ${w.join(' ')}; teach scripts/lab/first-run.ts`,
      );
    }
    installs.push(args);
  }
  if (installs.length === 0) throw new Error('the quick start installs nothing');

  const runs: string[][] = [];
  for (const line of after?.lines ?? []) {
    const w = words(line);
    if (w.length === 0) continue;
    const text = w.join(' ');
    if (text !== 'npm pkg set type=module' && text !== 'npx tsx agent.ts') {
      throw new Error(
        `unexpected command in the quick start: ${text}; teach scripts/lab/first-run.ts`,
      );
    }
    runs.push(w.slice(1));
  }
  if (!runs.some((args) => args[0] === 'tsx'))
    throw new Error('the quick start does not run agent.ts');

  return { installs, agent: `${agentBlock.lines.join('\n')}\n`, runs };
}

/** Pins the `@hashspan/*` packages of an install command to `version`, as the README cannot name a release candidate. */
export function pinHashspan(args: readonly string[], version: string): string[] {
  return args.map((arg) =>
    arg.startsWith('@hashspan/') && !arg.slice(1).includes('@') ? `${arg}@${version}` : arg,
  );
}

/** Where the quick start of the release `version` of `@hashspan/viem` is: its own git tag in hashspan's repository. */
export function readmeUrl(version: string): string {
  const tag = encodeURIComponent(`@hashspan/viem@${version}`);
  return `https://raw.githubusercontent.com/selimaytac/hashspan/${tag}/README.md`;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string | number; boolValue?: boolean };
}

interface OtlpSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: OtlpAttribute[];
  status?: { code?: string | number };
}

/** The spans of a Tempo trace (OTLP JSON), whichever of its envelopes the API used. */
export function traceSpans(body: unknown): OtlpSpan[] {
  const root = body as Record<string, unknown> | undefined;
  const nested = root?.trace as Record<string, unknown> | undefined;
  const resources = (root?.resourceSpans ?? root?.batches ?? nested?.resourceSpans ?? []) as {
    scopeSpans?: { spans?: OtlpSpan[] }[];
    instrumentationLibrarySpans?: { spans?: OtlpSpan[] }[];
  }[];
  return resources.flatMap((resource) =>
    (resource.scopeSpans ?? resource.instrumentationLibrarySpans ?? []).flatMap(
      (scope) => scope.spans ?? [],
    ),
  );
}

function attribute(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes?.find((entry) => entry.key === key)?.value;
  const found = value?.stringValue ?? value?.intValue;
  return found === undefined ? undefined : String(found);
}

/** Deviations of the trace from what the quick start promises: `pay_vendor` with a send and a confirm span under it. */
export function checkQuickStartTrace(spans: readonly OtlpSpan[], chainId: number): string[] {
  const problems: string[] = [];
  const parents = spans.filter((span) => span.name === 'pay_vendor');
  const parent = parents[0];
  if (parents.length !== 1 || !parent)
    return [`expected one pay_vendor span, found ${parents.length}`];
  for (const kind of ['send', 'confirm']) {
    const name = `${kind} ${chainId}`;
    const found = spans.filter((span) => span.name === name);
    if (found.length !== 1) {
      problems.push(`expected one "${name}" span, found ${found.length}`);
      continue;
    }
    const span = found[0];
    if (!span) continue;
    if (span.parentSpanId !== parent.spanId)
      problems.push(`"${name}" is not a child of pay_vendor`);
    if (!/^0x[0-9a-f]{64}$/.test(attribute(span, 'blockchain.tx.hash') ?? '')) {
      problems.push(`"${name}" has no blockchain.tx.hash`);
    }
    if (attribute(span, 'blockchain.chain.id') !== String(chainId)) {
      problems.push(`"${name}" has no blockchain.chain.id ${chainId}`);
    }
    if (String(span.status?.code ?? '') === '2' || span.status?.code === 'STATUS_CODE_ERROR') {
      problems.push(`"${name}" ended with error status`);
    }
  }
  const confirm = spans.find((span) => span.name === `confirm ${chainId}`);
  if (confirm && attribute(confirm, 'blockchain.tx.status') !== 'success') {
    problems.push('the confirm span has no success status');
  }
  return problems;
}
