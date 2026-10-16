/**
 * Structured logging with mandatory redaction.
 *
 * Rules enforced here:
 *  - never log Authorization headers, API keys, DB URLs, passwords or tokens,
 *  - never log a user's full profile / chat history (only counts and ids),
 *  - every line carries the request id so support can correlate a complaint with
 *    a server event without needing personal data.
 *
 * LOG_LEVEL = error | warn | info | debug  (default: info)
 */
import { redactSecrets, redactSecretsInString } from './security.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LogContext {
  requestId?: string
  fn?: string
  userId?: string
  route?: string
  status?: number
  durationMs?: number
  [key: string]: unknown
}

export interface Logger {
  error(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  debug(message: string, context?: LogContext): void
  child(context: LogContext): Logger
}

function resolveLevel(explicit?: string): LogLevel {
  const value = (explicit ?? 'info').toLowerCase()
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug' ? value : 'info'
}

/** Truncates long strings so a log line can never become a data dump. */
function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value
}

export function createLogger(baseContext: LogContext = {}, level: LogLevel = 'info'): Logger {
  const effectiveLevel = resolveLevel(level)

  const emit = (lvl: LogLevel, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[lvl] > LEVEL_ORDER[effectiveLevel]) return
    const merged = { ...baseContext, ...context }
    const safe = redactSecrets(merged) as Record<string, unknown>
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: truncate(redactSecretsInString(String(message)), 500),
      ...safe,
    }
    const serialized = JSON.stringify(line)
    if (lvl === 'error') console.error(serialized)
    else if (lvl === 'warn') console.warn(serialized)
    else console.log(serialized)
  }

  const logger: Logger = {
    error: (m, c) => emit('error', m, c),
    warn: (m, c) => emit('warn', m, c),
    info: (m, c) => emit('info', m, c),
    debug: (m, c) => emit('debug', m, c),
    child: (context) => createLogger({ ...baseContext, ...context }, effectiveLevel),
  }
  return logger
}

export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => nullLogger,
}

/** Safe description of an error for logs — message only, no stack to the client. */
export function describeError(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return {
      name: err.name,
      message: truncate(redactSecretsInString(err.message), 400),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  return { name: 'UnknownError', message: truncate(redactSecretsInString(String(err)), 400) }
}


