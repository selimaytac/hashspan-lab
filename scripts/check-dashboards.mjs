// Runs every panel query of dashboards/*.json against the local stack's Prometheus and Tempo over a time window and
// prints how many series or traces each returns. Usage: node scripts/check-dashboards.mjs [--since <seconds ago>] [--strict]
// With --strict a panel that returns nothing fails too, except the ones that stay empty on a healthy run (EXPECTED_EMPTY).
import { readdirSync, readFileSync } from 'node:fs';

const PROMETHEUS = process.env.LAB_PROMETHEUS ?? 'http://127.0.0.1:19090';
const TEMPO = process.env.LAB_TEMPO ?? 'http://127.0.0.1:13200';
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? Number(process.argv[sinceArg + 1]) : 3600;
const strict = process.argv.includes('--strict');
// Panels that stay empty on a healthy run: health.json shows failures only (the failed JSON-RPC requests of a healthy run
// are the eth_call revert replays it leaves out), and one x402 panel lists failed payments.
const EXPECTED_EMPTY = { 'health.json': '*', 'x402.json': ['Payments not verified or failed'] };
const mayBeEmpty = (file, title) => {
  const rule = EXPECTED_EMPTY[file];
  return rule === '*' || (Array.isArray(rule) && rule.includes(title));
};
const end = Math.floor(Date.now() / 1000);
const start = end - since;
const dir = new URL('../dashboards/', import.meta.url);

const substitute = (query) =>
  query
    .replaceAll('$job', '.+')
    .replaceAll('$__range', `${since}s`)
    .replaceAll('$__interval', '1h')
    .replaceAll('$__rate_interval', '1h');

function panels(node, out = []) {
  if (Array.isArray(node)) for (const item of node) panels(item, out);
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.targets)) out.push(node);
    for (const value of Object.values(node))
      if (value && typeof value === 'object') panels(value, out);
  }
  return out;
}

async function prometheus(expr) {
  const url = `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}&time=${end}`;
  const body = await (await fetch(url)).json();
  if (body.status !== 'success') return { error: body.error };
  return { count: body.data.result.length };
}

async function tempo(query) {
  const url = `${TEMPO}/api/search?q=${encodeURIComponent(query)}&start=${start}&end=${end}&limit=100`;
  const response = await fetch(url);
  if (!response.ok) return { error: `${response.status} ${(await response.text()).slice(0, 200)}` };
  return { count: ((await response.json()).traces ?? []).length };
}

let failures = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const dashboard = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  console.log(`${file}`);
  for (const panel of panels(dashboard.panels ?? [])) {
    for (const target of panel.targets) {
      const isTempo =
        target.queryType === 'traceql' || /tempo/i.test(JSON.stringify(target.datasource ?? ''));
      const raw = target.expr ?? target.query;
      if (!raw) continue;
      const result = await (isTempo ? tempo(substitute(raw)) : prometheus(substitute(raw)));
      const empty = !result.error && result.count === 0 && strict && !mayBeEmpty(file, panel.title);
      if (result.error || empty) failures++;
      const status = result.error
        ? `ERROR ${result.error}`
        : `${result.count} ${isTempo ? 'trace(s)' : 'series'}${empty ? ' EMPTY' : ''}`;
      console.log(
        `  ${status.padEnd(16)} ${panel.title}${target.refId ? ` [${target.refId}]` : ''}`,
      );
    }
  }
}
process.exitCode = failures > 0 ? 1 : 0;
