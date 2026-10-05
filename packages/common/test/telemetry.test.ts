import { createServer, type Server } from 'node:http';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labResource, startTelemetry } from '../src/index.js';

const servers: Server[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});

/** An OTLP/HTTP endpoint that answers every request with `status` and records the paths it was sent to. */
async function otlpReceiver(status = 200): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.statusCode = status;
      res.end();
    });
  }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, paths };
}

describe('labResource', () => {
  it('names the service, unless the OTEL variables say otherwise', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
    expect(labResource('treasury-agent').attributes[ATTR_SERVICE_NAME]).toBe('treasury-agent');
    vi.stubEnv('OTEL_SERVICE_NAME', 'other');
    expect(labResource('treasury-agent').attributes[ATTR_SERVICE_NAME]).toBe('other');
  });

  it('gives every run an instance id of its own, unless OTEL_RESOURCE_ATTRIBUTES sets one', () => {
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
    const first = labResource('treasury-agent').attributes['service.instance.id'];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(labResource('treasury-agent').attributes['service.instance.id']).not.toBe(first);
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'service.instance.id=run-42');
    expect(labResource('treasury-agent').attributes['service.instance.id']).toBe('run-42');
  });
});

describe('startTelemetry', () => {
  it('flushes, then snapshots the spans, then exports spans and metrics at shutdown', async () => {
    const receiver = await otlpReceiver();
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', receiver.url);
    const telemetry = startTelemetry({ serviceName: 'test-agent', env: {} });

    trace.getTracer('test').startSpan('before flush').end();
    // A histogram recorded through the global meter provider, as hashspan's tracker does.
    metrics.getMeter('test').createHistogram('blockchain.client.fee').record(42);
    const order: string[] = [];
    const { spans, errors } = await telemetry.finish(async () => {
      order.push('flush');
      // Like a confirm span that hashspan's flush ends.
      trace.getTracer('test').startSpan('ended by flush').end();
    });

    expect(order).toEqual(['flush']);
    expect(spans.map((s) => s.name)).toEqual(['before flush', 'ended by flush']);
    expect(spans[0]?.resource.attributes[ATTR_SERVICE_NAME]).toBe('test-agent');
    expect(errors).toEqual([]);
    expect(receiver.paths.sort()).toEqual(['/v1/metrics', '/v1/traces']);
  });

  it('exports nothing over OTLP when both exporters are none', async () => {
    const receiver = await otlpReceiver();
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', receiver.url);
    const telemetry = startTelemetry({
      serviceName: 'test-agent',
      env: { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' },
    });
    trace.getTracer('test').startSpan('kept in memory').end();
    metrics.getMeter('test').createHistogram('h').record(1);

    const { spans, errors } = await telemetry.finish();
    expect(spans.map((s) => s.name)).toEqual(['kept in memory']);
    expect(errors).toEqual([]);
    expect(receiver.paths).toEqual([]);
  });

  it('returns failed exports and a failed flush as safe messages, after shutting down anyway', async () => {
    const receiver = await otlpReceiver(401);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `${receiver.url}/secret-path`);
    const telemetry = startTelemetry({ serviceName: 'test-agent', env: {} });
    trace.getTracer('test').startSpan('span').end();
    metrics.getMeter('test').createHistogram('h').record(1);

    const { spans, errors } = await telemetry.finish(async () => {
      throw new Error('flush failed at https://rpc.example/key');
    });
    expect(spans).toHaveLength(1);
    expect(errors[0]).toBe('flush: Error');
    // The batch span processor also rejects its flush at shutdown when the export failed.
    expect(errors).toContain('metric export: OTLPExporterError (HTTP 401)');
    expect(errors).toContain('trace export: OTLPExporterError (HTTP 401)');
    expect(errors.join('\n')).not.toContain('secret-path');
    expect(receiver.paths.sort()).toEqual(['/secret-path/v1/metrics', '/secret-path/v1/traces']);
  });
});
