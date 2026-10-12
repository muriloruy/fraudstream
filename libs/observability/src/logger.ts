import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { REDACT_PATHS, REDACTED } from '@fraudstream/security';

export interface LoggerConfig {
  service: string;
  level?: string;
  /** Defaults to stdout. Tests pass a stream to capture log lines. */
  destination?: DestinationStream;
}

/** pino options shared by every service: JSON, UTC timestamps, PAN/secret redaction (SPEC §7, §10). */
export function loggerOptions(config: Pick<LoggerConfig, 'service' | 'level'>): LoggerOptions {
  return {
    level: config.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: config.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return config.destination
    ? pino(loggerOptions(config), config.destination)
    : pino(loggerOptions(config));
}

export type { Logger };
