/** The environment that points your own hashspan-instrumented agent at the lab's collector. */
export const OTLP_HTTP = 'http://127.0.0.1:14318';
export const OTLP_GRPC = '127.0.0.1:14317';

const HASHSPAN = 'https://github.com/selimaytac/hashspan';

/** What `pnpm lab connect` prints. `stackUp` says whether the collector answers right now. */
export function connectOutput(stackUp: boolean): string {
  return [
    stackUp
      ? 'The lab stack is up. Point your agent at it with these environment variables:'
      : 'The lab stack is not up yet: start it with `pnpm lab up` (or `make lab-up`). Then point your agent at it with:',
    '',
    `  OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_HTTP}`,
    '  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    '  OTEL_SERVICE_NAME=my-agent',
    '',
    `gRPC works too, on ${OTLP_GRPC}. Any service name works: the dashboards list every service under "All" and`,
    'offer each one in their service filter.',
    '',
    'How to instrument the agent, and when a short-lived process must flush its telemetry, is in hashspan itself:',
    `  ${HASHSPAN}#readme`,
    `  ${HASHSPAN}/tree/main/examples/ai-sdk-agent (an example agent)`,
    'Then open the dashboards with `pnpm lab status`.',
  ].join('\n');
}
