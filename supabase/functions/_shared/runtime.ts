/**
 * Runtime configuration and dependency selection.
 *
 * Pure module: it reads process environment through an injected accessor and
 * returns a validated, typed configuration. The Deno entrypoint
 * (`_shared/platform/deno.ts`) performs the one runtime-specific step — creating
 * the Supabase client — and then assembles a `Runtime` from these pieces.
 *
 * Everything is optional by design: a deployment with no Neo4j credentials and no
 * AI key still starts, reports its state honestly through `health-check`, and
 * serves the frontend's clearly-labelled local sample mode.
 */
import type { AiConfig, AiProvider } from './core/aiAdapter.ts'
import { createAiProvider } from './core/aiAdapter.ts'
import type { GraphReader } from './core/graphReader.ts'
import type { FixedWindowStore, RateLimitPolicy } from './core/rateLimit.ts'
import { MemoryFixedWindowStore, MemoryNonceStore, RATE_POLICIES } from './core/rateLimit.ts'
import type { NonceStore } from './core/security.ts'
import { createNeo4jReader, emptyGraphHint, resolveQueryEndpoint, type Neo4jConfig } from './core/neo4jReader.ts'
import type { AuthCheck, UserRepositories } from './platform/supabaseStore.ts'

export type EnvAccessor = (key: string) => string | undefined

export interface RuntimeLimits {
  maxRows: number
  maxContextChars: number
  requestMaxSkewMs: number
  mentorPerMinute: RateLimitPolicy
  mentorPerHour: RateLimitPolicy
  analysisPerMinute: RateLimitPolicy
  readPerMinute: RateLimitPolicy
  writePerMinute: RateLimitPolicy
  /** Per-address sign-in attempt ceiling (address is hashed before it is keyed). */
  authAttemptPerMinute: RateLimitPolicy
  /** Longer ceiling, so a slow trickle of guesses still runs out. */
  authAttemptPerHour: RateLimitPolicy
  /** Host-level ceiling, so one machine cannot walk a list of addresses. */
  authAttemptPerIpPerMinute: RateLimitPolicy
  maxJsonBodyBytes: number
}

export interface RuntimeConfig {
  neo4j: Neo4jConfig | null
  /** Reason Neo4j is unavailable, for the health check message. */
  neo4jIssue: string | null
  ai: AiConfig
  allowedOrigins: string[]
  limits: RuntimeLimits
  /** HMAC secret for replay protection on expensive endpoints. Optional. */
  signSecret: string | null
  /**
   * Secret pepper for rate-limit bucket keys (`RATE_LIMIT_PEPPER`).
   *
   * Without it the keys are still stable and still limit correctly, but they are
   * derived with a constant that is public in this repository, so a reader of the
   * counter table can recover the addresses and IPs behind them. See
   * `bucketKey` in core/rateLimit.ts and tests/security/exploit-bucket-key.test.ts.
   */
  rateLimitPepper: string | null
  /** When true, AI/write endpoints require a signed, single-use request. */
  requireRequestSigning: boolean
  logLevel: string
  environment: string
}

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function readRuntimeConfig(env: EnvAccessor): RuntimeConfig {
  const rawQueryUrl = (env('NEO4J_QUERY_URL') ?? '').trim()
  const rawUri = (env('NEO4J_URI') ?? env('NEO4J_BOLT_URI') ?? '').trim()
  const username = (env('NEO4J_USERNAME') ?? env('NEO4J_USER') ?? '').trim()
  const password = env('NEO4J_PASSWORD') ?? ''
  const database = (env('NEO4J_DATABASE') ?? 'neo4j').trim() || 'neo4j'

  let neo4j: Neo4jConfig | null = null
  let neo4jIssue: string | null = null

  const resolvedQueryUrl = resolveQueryEndpoint({ queryUrl: rawQueryUrl, uri: rawUri, database })
  const effectiveUsername = username || (rawUri ? 'neo4j' : '')

  if (!rawQueryUrl && !rawUri && !username && !password) {
    neo4jIssue =
      'Neo4j is not configured. Set NEO4J_QUERY_URL (or NEO4J_URI), NEO4J_USERNAME and NEO4J_PASSWORD as Edge Function secrets (see supabase/.env.example).'
  } else if (rawQueryUrl && !/^https:\/\//i.test(rawQueryUrl)) {
    // Refuse plain http: the Query API carries credentials in the Authorization
    // header and curriculum reads must not be downgradeable to cleartext.
    neo4jIssue = 'NEO4J_QUERY_URL must be an https:// URL.'
  } else if (!resolvedQueryUrl) {
    neo4jIssue = rawQueryUrl
      ? 'NEO4J_QUERY_URL is not a valid HTTPS Query API URL (or contains embedded credentials).'
      : 'NEO4J_URI must be a valid neo4j+s://, bolt+s://, or https:// AuraDB URI.'
  } else if (!effectiveUsername || !password) {
    neo4jIssue =
      'Neo4j credentials are incomplete. Set both NEO4J_USERNAME and NEO4J_PASSWORD alongside NEO4J_QUERY_URL or NEO4J_URI.'
  } else {
    neo4j = {
      queryUrl: resolvedQueryUrl,
      username: effectiveUsername,
      password,
      database,
      timeoutMs: num(env('NEO4J_TIMEOUT_MS'), 8000, 1000, 30_000),
      maxRows: num(env('NEO4J_MAX_ROWS'), 400, 10, 2000),
    }
  }

  const providerRaw = (env('AI_PROVIDER') ?? 'none').trim().toLowerCase()
  const provider = providerRaw === 'gemini' || providerRaw === 'openai-compatible' ? providerRaw : 'none'
  const ai: AiConfig = {
    provider,
    apiKey:
      provider === 'gemini'
        ? (env('GEMINI_API_KEY') ?? '')
        : provider === 'openai-compatible'
          ? (env('OPENAI_COMPATIBLE_API_KEY') ?? '')
          : '',
    model:
      provider === 'gemini'
        ? (env('GEMINI_MODEL') ?? 'gemini-2.0-flash')
        : (env('OPENAI_COMPATIBLE_MODEL') ?? ''),
    baseUrl: env('OPENAI_COMPATIBLE_BASE_URL') ?? '',
    timeoutMs: num(env('AI_TIMEOUT_MS'), 20_000, 2000, 60_000),
    maxOutputTokens: num(env('AI_MAX_OUTPUT_TOKENS'), 800, 64, 4096),
  }

  const origins = (env('ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    neo4j,
    neo4jIssue,
    ai,
    allowedOrigins: origins,
    limits: {
      maxRows: neo4j?.maxRows ?? 400,
      maxContextChars: num(env('AI_MAX_CONTEXT_CHARS'), 12_000, 2000, 40_000),
      requestMaxSkewMs: num(env('REQUEST_MAX_SKEW_MS'), 120_000, 10_000, 900_000),
      mentorPerMinute: {
        limit: num(env('RATE_LIMIT_CHAT_PER_MINUTE'), RATE_POLICIES.mentorChatPerMinute.limit, 1, 120),
        windowSeconds: 60,
      },
      mentorPerHour: { limit: RATE_POLICIES.mentorChatPerHour.limit, windowSeconds: 3600 },
      analysisPerMinute: {
        limit: num(env('RATE_LIMIT_ANALYSIS_PER_MINUTE'), RATE_POLICIES.analysisPerMinute.limit, 1, 300),
        windowSeconds: 60,
      },
      readPerMinute: {
        limit: num(env('RATE_LIMIT_DEFAULT_PER_MINUTE'), RATE_POLICIES.readPerMinute.limit, 5, 600),
        windowSeconds: 60,
      },
      writePerMinute: {
        limit: num(env('RATE_LIMIT_WRITE_PER_MINUTE'), RATE_POLICIES.writePerMinute.limit, 1, 200),
        windowSeconds: 60,
      },
      authAttemptPerMinute: {
        limit: num(env('AUTH_ATTEMPTS_PER_MINUTE'), RATE_POLICIES.authAttemptPerMinute.limit, 1, 60),
        windowSeconds: 60,
      },
      authAttemptPerHour: {
        limit: num(env('AUTH_ATTEMPTS_PER_HOUR'), RATE_POLICIES.authAttemptPerHour.limit, 1, 600),
        windowSeconds: 3600,
      },
      authAttemptPerIpPerMinute: {
        limit: num(env('AUTH_ATTEMPTS_PER_IP_PER_MINUTE'), RATE_POLICIES.authAttemptPerIpPerMinute.limit, 1, 300),
        windowSeconds: 60,
      },
      maxJsonBodyBytes: num(env('MAX_JSON_BODY_BYTES'), 32 * 1024, 4096, 128 * 1024),
    },
    signSecret: (env('REQUEST_SIGNING_SECRET') ?? '').trim() || null,
    rateLimitPepper: (env('RATE_LIMIT_PEPPER') ?? '').trim() || null,
    requireRequestSigning: (env('REQUIRE_REQUEST_SIGNING') ?? 'false').trim().toLowerCase() === 'true',
    logLevel: (env('LOG_LEVEL') ?? 'info').trim(),
    environment: (env('ENVIRONMENT') ?? 'production').trim(),
  }
}

export interface ReaderSelection {
  reader: GraphReader | null
  reason: string | null
  setupHint?: string
}

export interface ReaderDeps {
  fetchImpl?: typeof fetch
  onEvent?: (event: { type: 'query' | 'error'; cypherTag?: string; ms?: number; status?: number; rows?: number }) => void
}

export function createReaderFromConfig(config: RuntimeConfig, deps: ReaderDeps = {}): ReaderSelection {
  if (!config.neo4j) {
    return { reader: null, reason: config.neo4jIssue ?? 'Neo4j is not configured.', setupHint: emptyGraphHint() }
  }
  return {
    reader: createNeo4jReader({ ...config.neo4j, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.onEvent ? { onEvent: deps.onEvent } : {}) }),
    reason: null,
  }
}

/**
 * Which storage backend the repositories talk to.
 *
 * The API is deliberately identical on both, but the *explanation* is not: the
 * health check and the feedback receipt tell the user where their data lives, and
 * "your Supabase project" is a false statement on an Appwrite deployment. So the
 * backend is part of the runtime rather than something each message guesses at.
 */
export type StorageBackend = 'supabase' | 'appwrite'

/** Assembled per-request dependencies for the handlers. */
export interface Runtime {
  config: RuntimeConfig
  reader: GraphReader | null
  /** Non-null when `reader` is null; explains why in user-safe language. */
  readerReason: string | null
  readerSetupHint?: string
  ai: AiProvider
  repos: UserRepositories | null
  /** Set when `repos` is non-null; `null` means guest mode with no server storage. */
  storageBackend: StorageBackend | null
  rateLimit: FixedWindowStore
  nonce: NonceStore
  verifyAuth: (headers: Headers) => Promise<AuthCheck>
  now: () => number
}

export interface RuntimeParts {
  config: RuntimeConfig
  reader: GraphReader | null
  readerReason: string | null
  readerSetupHint?: string
  repos: UserRepositories | null
  storageBackend?: StorageBackend
  rateLimit?: FixedWindowStore
  nonce?: NonceStore
  verifyAuth?: (headers: Headers) => Promise<AuthCheck>
  ai?: AiProvider
  fetchImpl?: typeof fetch
}

/**
 * Assembles a Runtime. The in-memory stores are used only when no client is
 * available (local development); they are explicitly documented as
 * single-instance-only.
 *
 * `storageBackend` defaults to 'supabase' when repositories are present, because
 * that is what the repositories are when nobody says otherwise — the in-memory
 * doubles the tests inject behave like the Postgres ones.
 */
export function assembleRuntime(parts: RuntimeParts): Runtime {
  const ai =
    parts.ai ??
    createAiProvider({
      ...parts.config.ai,
      ...(parts.fetchImpl ? { fetchImpl: parts.fetchImpl } : {}),
    })

  return {
    config: parts.config,
    reader: parts.reader,
    readerReason: parts.readerReason,
    ...(parts.readerSetupHint ? { readerSetupHint: parts.readerSetupHint } : {}),
    ai,
    repos: parts.repos,
    storageBackend: parts.repos ? (parts.storageBackend ?? 'supabase') : null,
    rateLimit: parts.rateLimit ?? new MemoryFixedWindowStore(),
    nonce: parts.nonce ?? new MemoryNonceStore(),
    verifyAuth:
      parts.verifyAuth ??
      (async () => ({ status: 'none' }) as AuthCheck),
    now: () => Date.now(),
  }
}


