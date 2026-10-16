/**
 * Minimal HTTP plumbing for Edge Functions, shared by every handler.
 *
 * Responsibilities:
 *  - strict CORS (explicit allow-list, never `*` together with credentials),
 *  - method + content-type + body-size enforcement,
 *  - one place where thrown errors become safe JSON responses,
 *  - correlation ids, cache-control for private data, security headers.
 *
 * Handlers are written as functions of `ApiRequest` -> `HttpResponse`, which is
 * why they can be unit-tested in Node without a running Edge runtime.
 */
import { AppError, toAppError } from './errors.ts'
import { createLogger, describeError, type Logger, type LogLevel } from './log.ts'
import { assertSafeBodyText, isJsonContentType, MAX_JSON_BODY_BYTES, randomToken } from './security.ts'

/** Narrow a config/env string to a known log level; anything else is ignored. */
function asLogLevel(value: string | undefined): LogLevel | null {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug' ? value : null
}

export interface ApiRequest {
  method: string
  /** Path only, e.g. "/mentor-chat" (used for signatures and logging). */
  path: string
  url: URL
  headers: Headers
  /** Raw body text; the handler decides how to parse it. */
  bodyText: string
  /** Verified user id, or null for anonymous/guest requests. */
  userId: string | null
  /** Client IP used for coarse rate limiting (hashed, never stored). */
  clientIp: string | null
  requestId: string
  logger: Logger
  /** Environment access, injected so tests can supply a fake. */
  env: (key: string) => string | undefined
}

export interface HttpResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Private data must never be cached by a shared proxy or service worker.
      'cache-control': 'no-store',
      ...headers,
    },
  }
}

/** Public, cacheable read response (anonymous curriculum data only). */
export function publicJson(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return json(status, body, { 'cache-control': 'public, max-age=300, stale-while-revalidate=600', ...headers })
}

export function empty(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, body: null, headers: { 'cache-control': 'no-store', ...headers } }
}

/* ==========================================================================
 * CORS
 * ========================================================================== */

export interface CorsOptions {
  allowedOrigins: string[]
}

/**
 * Returns CORS headers for an Origin, or null when the origin is not allowed.
 * Unlisted origins receive no CORS headers, so the browser blocks the response.
 */
export function corsHeaders(origin: string | null, options: CorsOptions): Record<string, string> | null {
  if (!origin) return {}
  const normalize = (value: string) => value.replace(/\/$/, '').toLowerCase()
  const cleanOrigin = normalize(origin)

  const isAllowed = options.allowedOrigins
    .map((value) => value.trim())
    .filter(Boolean)
    .some((entry) => {
      const candidate = normalize(entry)
      if (candidate === cleanOrigin) return true
      if (candidate === '*') return true
      if (candidate.includes('*')) {
        const [scheme, rest] = candidate.split('://')
        if (!rest) return false
        const suffix = rest.replace('*.', '.')
        return cleanOrigin.startsWith(`${scheme}://`) && cleanOrigin.endsWith(suffix)
      }
      return false
    })

  if (!isAllowed) return null

  /*
   * A bare `*` in the allow-list means "any origin may read this response", and
   * that is only safe for a response with no ambient authority: no cookies, no
   * credentials. It must therefore never be spelled as echo-the-origin plus
   * `allow-credentials`, which is the same thing to a browser but turns every
   * public endpoint into a credentialed one for every site on the internet.
   * An operator who wrote `*` gets exactly that and nothing more; a credentialed
   * endpoint is spelled with explicit origins, or with subdomain patterns, which
   * are the operator's own reviewed decision.
   */
  const allowsAnyOrigin = options.allowedOrigins.some((value) => value.trim() === '*')
  if (allowsAnyOrigin) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers':
        'authorization,content-type,x-gm-timestamp,x-gm-nonce,x-gm-signature,x-client-version',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
  }

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers':
      'authorization,content-type,x-gm-timestamp,x-gm-nonce,x-gm-signature,x-client-version',
    'access-control-max-age': '600',
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  }
}

export function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
}

/* ==========================================================================
 * Request construction
 * ========================================================================== */

export interface BuildRequestOptions {
  /** Verifies the Supabase JWT. Injected so tests can fake authentication. */
  verifyAuth?: (headers: Headers) => Promise<string | null>
  maxBodyBytes?: number
  logLevel?: string
}

function denoEnv(key: string): string | undefined {
  return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key)
}

export async function buildApiRequest(request: Request, options: BuildRequestOptions = {}): Promise<ApiRequest> {
  const url = new URL(request.url)
  const headers = request.headers
  const requestId = headers.get('x-request-id')?.slice(0, 40) || randomToken(8)
  const maxBody = options.maxBodyBytes ?? MAX_JSON_BODY_BYTES

  let bodyText = ''
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const declaredLength = Number(headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > maxBody) {
      throw new AppError('payload_too_large', { requestId })
    }
    bodyText = await request.text()
    try {
      assertSafeBodyText(bodyText, maxBody)
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      throw new AppError(name === 'PayloadTooLarge' ? 'payload_too_large' : 'bad_request', {
        requestId,
        internal: name,
      })
    }
    if (bodyText.length > 0 && !isJsonContentType(headers.get('content-type'))) {
      throw new AppError('bad_request', {
        requestId,
        publicMessage: 'Requests with a body must use Content-Type: application/json.',
      })
    }
  }

  const clientIp =
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null

  let userId: string | null = null
  if (options.verifyAuth) {
    try {
      userId = await options.verifyAuth(headers)
    } catch {
      userId = null
    }
  }

  const logger = createLogger(
    {
      requestId,
      fn: url.pathname.split('/').filter(Boolean).pop() ?? 'unknown',
      route: url.pathname,
      userId: userId ?? undefined,
    },
    asLogLevel(options.logLevel) ?? asLogLevel(denoEnv('LOG_LEVEL')) ?? 'info',
  )

  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    url,
    headers,
    bodyText,
    userId,
    clientIp,
    requestId,
    logger,
    env: (key: string) => denoEnv(key),
  }
}

/* ==========================================================================
 * Response finishing
 * ========================================================================== */

export interface FinishOptions {
  cors?: Record<string, string> | null
  extraHeaders?: Record<string, string>
}

export function finish(response: HttpResponse, options: FinishOptions = {}): Response {
  const headers = new Headers({
    ...securityHeaders(),
    ...(options.extraHeaders ?? {}),
    ...(options.cors ?? {}),
  })
  for (const [key, value] of Object.entries(response.headers)) headers.set(key, value)
  const body = response.body === null ? null : JSON.stringify(response.body)
  return new Response(body, { status: response.status, headers })
}

/** Converts any thrown value into a safe JSON error response. */
export function toErrorResponse(error: unknown, options: FinishOptions = {}): Response {
  const appError = toAppError(error)
  return finish(json(appError.status, appError.toFailure()), options)
}

export function logError(error: unknown, request: ApiRequest, extra: Record<string, unknown> = {}): void {
  const appError = toAppError(error)
  request.logger.error('request failed', {
    code: appError.code,
    status: appError.status,
    ...describeError(appError.internal ?? error),
    ...extra,
  })
}

/* ==========================================================================
 * Routing helpers
 * ========================================================================== */

export type HandlerResult = Promise<HttpResponse>
export type ApiHandler = (request: ApiRequest, params: Record<string, string>) => HandlerResult

export interface RouteDefinition {
  handler: ApiHandler
  /** Authentication required (401 when missing). */
  requiresAuth?: boolean
}

export function methodNotAllowed(allowed: string[]): HttpResponse {
  return json(
    405,
    { ok: false, error: { code: 'bad_request', message: `Use one of: ${allowed.join(', ')}.` } },
    { allow: `${allowed.join(', ')}, OPTIONS` },
  )
}

export function notFound(message = 'Unknown endpoint.'): HttpResponse {
  return json(404, { ok: false, error: { code: 'not_found', message } })
}

/** Parses a JSON body defensively; shape validation is the caller's job. */
export function parseJsonBody(request: ApiRequest): unknown {
  if (request.bodyText.trim().length === 0) return {}
  try {
    return JSON.parse(request.bodyText)
  } catch {
    throw new AppError('bad_request', {
      requestId: request.requestId,
      publicMessage: 'The request body is not valid JSON.',
    })
  }
}

/** Standard success envelope. */
export function envelope<T>(data: T, meta: Record<string, unknown>): HttpResponse {
  return json(200, { ok: true, data, meta })
}

/** Standard failure envelope built from an AppError. */
export function failure(error: AppError): HttpResponse {
  return json(error.status, error.toFailure())
}


