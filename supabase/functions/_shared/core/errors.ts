/**
 * Error handling & information-leakage control.
 *
 * Principle: the client receives a stable machine code plus a message written
 * for a student. Stack traces, SQL/Cypher fragments, upstream bodies, hostnames
 * and credential hints stay on the server and are only emitted to logs with a
 * request id used for correlation.
 */
import type { ApiErrorCode, ApiFailure } from './types.ts'

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  dependency_unavailable: 502,
  timeout: 504,
  not_configured: 503,
  internal: 500,
}

/** Safe, user-facing copy. Never contains internal detail. */
const DEFAULT_MESSAGE: Record<ApiErrorCode, string> = {
  bad_request: 'That request could not be understood. Check the values you sent and try again.',
  validation_failed: 'Some of the information you entered is not valid. Please review the highlighted fields.',
  unauthorized: 'Please sign in to continue.',
  forbidden: 'You do not have access to this record.',
  not_found: 'We could not find that item in the knowledge graph.',
  conflict: 'That record already exists or was changed elsewhere. Reload and try again.',
  payload_too_large: 'That request was too large. Please send less data.',
  rate_limited: 'You are sending requests too quickly. Please wait a moment and try again.',
  dependency_unavailable: 'A required service is temporarily unavailable. The rest of the app still works.',
  timeout: 'The request took too long. Please try again.',
  not_configured: 'This feature is not configured on the server yet.',
  internal: 'Something went wrong on our side. Please try again in a moment.',
}

export interface AppErrorOptions {
  /** Internal-only detail. Logged, never returned. */
  internal?: unknown
  fields?: Record<string, string>
  retryAfterSeconds?: number
  requestId?: string
  /** Override the user-facing message (must stay safe). */
  publicMessage?: string
  /** Extra log context that has already been redacted by the caller. */
  context?: Record<string, unknown>
}

export class AppError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly publicMessage: string
  readonly fields?: Record<string, string>
  readonly retryAfterSeconds?: number
  readonly requestId?: string
  readonly internal?: unknown
  readonly context?: Record<string, unknown>

  constructor(code: ApiErrorCode, options: AppErrorOptions = {}) {
    super(options.publicMessage ?? DEFAULT_MESSAGE[code])
    this.name = 'AppError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.publicMessage = options.publicMessage ?? DEFAULT_MESSAGE[code]
    this.fields = options.fields
    this.retryAfterSeconds = options.retryAfterSeconds
    this.requestId = options.requestId
    this.internal = options.internal
    this.context = options.context
  }

  toFailure(): ApiFailure {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(this.fields && Object.keys(this.fields).length > 0 ? { fields: this.fields } : {}),
        ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
        ...(this.requestId ? { requestId: this.requestId } : {}),
      },
    }
  }
}

/** Wraps anything thrown into an AppError without leaking the original text. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err

  if (err instanceof Error) {
    // Surface only errors we threw deliberately; everything else becomes generic.
    if (err.name === 'AbortError' || /timed?\s?out|timeout/i.test(err.message)) {
      return new AppError('timeout', { internal: err })
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|dns/i.test(err.message)) {
      return new AppError('dependency_unavailable', { internal: err })
    }
    return new AppError('internal', { internal: err })
  }
  return new AppError('internal', { internal: err })
}

/**
 * Converts a validation library failure (zod) into an AppError with per-field
 * messages. Field names are echoed; entered values never are (they may be
 * private, and echoing them back into HTML is an XSS vector).
 */
export function validationError(fields: Record<string, string>): AppError {
  return new AppError('validation_failed', { fields })
}


