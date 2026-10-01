type LogLevel = 'info' | 'warn' | 'error';
type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Minimal structured logger for Workers Observability. Callers must only pass
 * operational fields (event names, IDs, counts); never customer details.
 */
function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const logger = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, error: unknown, fields?: LogFields) =>
    write('error', event, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    }),
};
