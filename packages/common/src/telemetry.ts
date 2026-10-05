import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { safeErrorMessage } from './errors.js';

export interface TelemetryOptions {
  /** `service.name`, unless `OTEL_SERVICE_NAME` or `OTEL_RESOURCE_ATTRIBUTES` say otherwise. */
  serviceName: string;
  /**
   * Whether spans and metrics are also exported over OTLP (HTTP/protobuf), configured by the standard
   * `OTEL_EXPORTER_OTLP_*` variables. Default: true unless `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` is `none`.
   */
  otlp?: { traces: boolean; metrics: boolean };
  /** Environment to read `OTEL_*_EXPORTER` from; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Extra metric readers, e.g. an in-memory one in tests. */
  metricReaders?: MetricReader[];
}

export interface LabTelemetry {
  tracerProvider: NodeTracerProvider;
  meterProvider: MeterProvider;
  /**
   * Ends the run's telemetry, in the order a short-lived process needs: `flush` first (hashspan's, so confirm spans
   * still waiting end), then a snapshot of the finished spans for the in-process checks, then the tracer provider's
   * shutdown and the meter provider's shutdown, each of which exports what is left. Never throws: every step runs
   * even when an earlier one failed, and failures are returned as safe messages.
   */
  finish(flush?: () => Promise<unknown>): Promise<FinishedTelemetry>;
}

export interface FinishedTelemetry {
  /** Spans that ended during the run, including those `flush` ended. */
  spans: ReadableSpan[];
  /** What failed while flushing or shutting down, e.g. an unreachable OTLP endpoint; empty when nothing did. */
  errors: string[];
}

/**
 * The service the telemetry belongs to, with a new `service.instance.id` per process: every run is a short-lived
 * process whose cumulative metrics start at zero, so each run gets series of its own (Prometheus' `instance` label)
 * rather than resetting the previous run's. A `NodeTracerProvider` does not read the `OTEL_*` resource variables by
 * itself (`NodeSDK` does), so they are detected here and win over these defaults.
 */
export function labResource(serviceName: string): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'service.instance.id': globalThis.crypto.randomUUID(),
  }).merge(detectResources({ detectors: [envDetector] }));
}

/**
 * Registers a tracer provider and a meter provider as the global ones. Spans go to an in-memory exporter, for the
 * run's own checks, and to OTLP; metrics go to OTLP through a periodic reader, whose last export happens at shutdown.
 */
/** The OTLP exporters, recording every failed export (ExportResultCode.FAILED is 1) into `errors`. */
function reportingExporters(errors: string[]) {
  const report = (what: string) => (result: { code: number; error?: Error }) => {
    if (result.code !== 0) {
      // An OTLPExporterError carries the HTTP status as `code`; its message may echo the response body.
      const status = (result.error as { code?: unknown } | undefined)?.code;
      const reason = result.error ? safeErrorMessage(result.error) : 'failed';
      errors.push(
        `${what} export: ${reason}${typeof status === 'number' ? ` (HTTP ${status})` : ''}`,
      );
    }
  };
  class Traces extends OTLPTraceExporter {
    override export(...[items, done]: Parameters<OTLPTraceExporter['export']>): void {
      const onTraces = report('trace');
      super.export(items, (result) => {
        onTraces(result);
        done(result);
      });
    }
  }
  class Metrics extends OTLPMetricExporter {
    override export(...[items, done]: Parameters<OTLPMetricExporter['export']>): void {
      const onMetrics = report('metric');
      super.export(items, (result) => {
        onMetrics(result);
        done(result);
      });
    }
  }
  return { traces: () => new Traces(), metrics: () => new Metrics() };
}

export function startTelemetry(options: TelemetryOptions): LabTelemetry {
  const env = options.env ?? process.env;
  const otlp = options.otlp ?? {
    traces: env.OTEL_TRACES_EXPORTER !== 'none',
    metrics: env.OTEL_METRICS_EXPORTER !== 'none',
  };
  const resource = labResource(options.serviceName);
  const errors: string[] = [];
  const exporters = reportingExporters(errors);

  const memory = new InMemorySpanExporter();
  const spanProcessors: SpanProcessor[] = [new SimpleSpanProcessor(memory)];
  if (otlp.traces) spanProcessors.push(new BatchSpanProcessor(exporters.traces()));
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();

  const readers: MetricReader[] = [...(options.metricReaders ?? [])];
  if (otlp.metrics) {
    readers.push(new PeriodicExportingMetricReader({ exporter: exporters.metrics() }));
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    tracerProvider,
    meterProvider,
    async finish(flush) {
      const step = async (what: string, run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (error) {
          errors.push(`${what}: ${safeErrorMessage(error)}`);
        }
      };
      if (flush) await step('flush', flush);
      // The in-memory exporter forgets its spans at shutdown: take them first.
      const spans = [...memory.getFinishedSpans()];
      await step('tracer provider shutdown', () => tracerProvider.shutdown());
      await step('meter provider shutdown', () => meterProvider.shutdown());
      return { spans, errors: [...errors] };
    },
  };
}
