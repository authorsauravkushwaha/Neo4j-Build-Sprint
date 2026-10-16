/**
 * Helpers shared by every handler: authorisation, rate limiting, replay
 * protection, response envelopes and metadata.
 *
 * These are the choke points where security decisions are made, so they are kept
 * in one small file that is easy to review and easy to unit-test.
 */
import { AppError } from '../core/errors.ts'
import type { ApiMeta } from '../core/types.ts'
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { envelope, publicJson } from '../core/http.ts'
import { bucketKey, checkRateLimit, type RateLimitPolicy } from '../core/rateLimit.ts'
import { buildRequestSignature, sanitizeUntrustedText, verifySignedRequest } from '../core/security.ts'
import type { GraphReader } from '../core/graphReader.ts'
import type { Runtime } from '../runtime.ts'

/* ==========================================================================
 * Reader availability
 * ========================================================================== */

export function requireReader(runtime: Runtime, request: ApiRequest): GraphReader {
  if (runtime.reader) return runtime.reader
  throw new AppError('not_configured', {
    requestId: request.requestId,
    publicMessage:
      'This deployment has no Neo4j knowledge graph configured, so live graph features are unavailable. The app keeps working with the bundled sample dataset in the browser.',
    context: { reason: runtime.readerReason ?? 'unknown' },
  })
}

export function metaFor(
  reader: GraphReader,
  input: { ms?: number; truncated?: boolean; selectionNote?: string } = {},
): ApiMeta {
  return {
    // Never claim live data for a local dataset, and vice versa.
    source: reader.kind === 'neo4j' ? 'neo4j-live' : 'local-sample',
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    ...(input.selectionNote ? { selectionNote: input.selectionNote } : {}),
    ...(input.ms !== undefined ? { queryMs: input.ms } : {}),
    generatedAt: new Date().toISOString(),
  }
}

export function ok<T>(data: T, meta: ApiMeta, _request: ApiRequest): HttpResponse {
  // Private/graph responses are never cached by the service worker; the frontend
  // decides what may be cached publicly, and the SW rule excludes auth'd calls.
  return envelope(data, meta as unknown as Record<string, unknown>)
}

export function okPublic<T>(data: T, meta: ApiMeta): HttpResponse {
  // Only used for anonymous curriculum reads that are safe to cache briefly.
  return publicJson(200, { ok: true, data, meta })
}

/* ==========================================================================
 * Authentication / authorisation
 * ========================================================================== */

export async function currentUser(runtime: Runtime, request: ApiRequest): Promise<string | null> {
  const check = await runtime.verifyAuth(request.headers)
  if (check.status === 'valid') return check.userId
  return null
}

/** Authentication is not authorisation: this proves *who*, callers then filter by owner. */
export async function requireUser(runtime: Runtime, request: ApiRequest): Promise<string> {
  const check = await runtime.verifyAuth(request.headers)
  if (check.status === 'valid') return check.userId
  if (check.status === 'invalid') {
    throw new AppError('unauthorized', {
      requestId: request.requestId,
      publicMessage: 'Your session has expired or is not valid. Please sign in again.',
      context: { reason: check.reason },
    })
  }
  throw new AppError('unauthorized', { requestId: request.requestId })
}

export function requireRepos(runtime: Runtime, request: ApiRequest): NonNullable<Runtime['repos']> {
  if (!runtime.repos) {
    throw new AppError('not_configured', {
      requestId: request.requestId,
      publicMessage: 'Account storage is not configured on this deployment, so saving is unavailable. Guest mode still works.',
    })
  }
  return runtime.repos
}

/* ==========================================================================
 * Rate limiting
 * ========================================================================== */

/** Prefers the verified user id; falls back to IP; never stores either raw. */
export async function limitScopeIdentifier(runtime: Runtime, request: ApiRequest): Promise<string> {
  const check = await runtime.verifyAuth(request.headers)
  if (check.status === 'valid') return `u:${check.userId}`
  return `ip:${request.clientIp ?? 'unknown'}`
}

export async function enforceRateLimit(
  runtime: Runtime,
  request: ApiRequest,
  policy: RateLimitPolicy,
  scope: string,
): Promise<{ limit: number; remaining: number; resetSeconds: number }> {
  const identifier = await limitScopeIdentifier(runtime, request)
  const key = await bucketKey(scope, identifier)
  const result = await checkRateLimit(runtime.rateLimit, key, policy, runtime.now())
  if (!result.allowed) {
    throw new AppError('rate_limited', {
      requestId: request.requestId,
      retryAfterSeconds: result.resetSeconds,
      publicMessage: `Too many requests (limit ${result.limit} per ${policy.windowSeconds === 60 ? 'minute' : 'hour'}). Try again in ${result.resetSeconds}s.`,
      context: { bucket: result.bucket },
    })
  }
  return result
}

/* ==========================================================================
 * Replay protection
 * ========================================================================== */

export interface SigningStatus {
  required: boolean
  reason: string
}

export function signingStatus(runtime: Runtime): SigningStatus {
  const required = runtime.config.requireRequestSigning && runtime.config.signSecret !== null
  return {
    required,
    reason: required
      ? 'This deployment requires timestamped, single-use signed requests for AI and write endpoints.'
      : 'Request signing is optional on this deployment (set REQUIRE_REQUEST_SIGNING=true and REQUEST_SIGNING_SECRET to enforce it).',
  }
}

/**
 * Verifies that a request is fresh and not a replay.
 *
 * Enabled by `REQUIRE_REQUEST_SIGNING=true` with `REQUEST_SIGNING_SECRET` set.
 * The shared secret is the caller's Supabase access token, which the server has
 * already validated against the Auth server — so the server can recompute the
 * signature without storing any per-user secret.
 *
 * Without this, replay of an expensive POST is still constrained by: the JWT
 * expiry, per-user rate limits driven by a shared Postgres counter, and the fact
 * that all bodies are validated. This helper closes the remaining gap.
 */
export async function enforceSignedRequest(runtime: Runtime, request: ApiRequest): Promise<void> {
  if (!signingStatus(runtime).required) return

  const secret = runtime.config.signSecret
  if (!secret) return

  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw new AppError('unauthorized', {
      requestId: request.requestId,
      publicMessage: 'This endpoint requires a signed request. Sign in and retry.',
    })
  }

  const timestamp = Number(request.headers.get('x-gm-timestamp') ?? '0')
  const nonce = (request.headers.get('x-gm-nonce') ?? '').trim()
  const signature = (request.headers.get('x-gm-signature') ?? '').trim()

  if (!timestamp || !nonce || !signature) {
    throw new AppError('bad_request', {
      requestId: request.requestId,
      publicMessage: 'Missing request-signature headers (x-gm-timestamp, x-gm-nonce, x-gm-signature).',
    })
  }
  if (!/^[0-9a-f]{16,64}$/i.test(nonce)) {
    throw new AppError('bad_request', { requestId: request.requestId, publicMessage: 'Malformed nonce.' })
  }

  // The key is the caller's validated access token, namespaced by the server secret.
  const key = `${secret}:${token}`
  const verdict = await verifySignedRequest({
    secret: key,
    parts: {
      method: request.method,
      path: request.path,
      body: request.bodyText,
      timestampMs: timestamp,
      nonce,
    },
    signature,
    maxSkewMs: runtime.config.limits.requestMaxSkewMs,
    nowMs: runtime.now(),
  })

  if (!verdict.ok) {
    throw new AppError(verdict.reason === 'mismatch' ? 'forbidden' : 'bad_request', {
      requestId: request.requestId,
      publicMessage:
        verdict.reason === 'stale' || verdict.reason === 'future'
          ? 'The request timestamp is outside the accepted window. Your device clock may be wrong.'
          : 'The request signature did not match.',
      context: { verdict: verdict.reason },
    })
  }

  // Single-use nonce: proves the request was not replayed.
  let claimed = false
  try {
    claimed = await runtime.nonce.claim(nonce, runtime.config.limits.requestMaxSkewMs * 2)
  } catch (error) {
    throw new AppError('dependency_unavailable', {
      requestId: request.requestId,
      publicMessage: 'Replay protection is temporarily unavailable, so the request was rejected. Please retry.',
      internal: error,
    })
  }
  if (!claimed) {
    throw new AppError('conflict', {
      requestId: request.requestId,
      publicMessage: 'This request was already processed (replay detected). Send a new request.',
    })
  }
}

/** Client-side helper exported for tests and for the browser client. */
export async function signRequest(
  secret: string,
  parts: { method: string; path: string; body: string; timestampMs: number; nonce: string },
): Promise<string> {
  return buildRequestSignature(secret, parts)
}

/* ==========================================================================
 * Body text limits
 * ========================================================================== */

export function boundedText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') {
    throw new AppError('validation_failed', { fields: { [field]: 'Expected a text value.' } })
  }
  const clean = sanitizeUntrustedText(value, max)
  if (clean.length === 0) {
    throw new AppError('validation_failed', { fields: { [field]: 'This field cannot be empty.' } })
  }
  return clean
}

export function notFoundFor(kind: string, id: string, request: ApiRequest): AppError {
  return new AppError('not_found', {
    requestId: request.requestId,
    publicMessage: `The knowledge graph has no ${kind} with the id "${id.slice(0, 72)}".`,
  })
}


