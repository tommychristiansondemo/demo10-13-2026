// Structured JSON logs + CloudWatch Embedded Metric Format (metrics extracted from log lines, no API calls).
import { config } from './config.js';

export function log(logType: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ log_type: logType, ts: new Date().toISOString(), ...fields }));
}

export function metric(name: string, value: number, unit: 'Milliseconds' | 'Count', dims: Record<string, string>): void {
  if (config.localDev) return;
  const dimKeys = Object.keys(dims);
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: config.metricsNamespace, Dimensions: [dimKeys], Metrics: [{ Name: name, Unit: unit }] }],
      },
      ...dims,
      [name]: value,
    }),
  );
}
