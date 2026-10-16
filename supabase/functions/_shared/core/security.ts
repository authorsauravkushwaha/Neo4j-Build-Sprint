/**
 * Security primitives shared by the API layer, the recommendation engine and
 * the frontend. Pure functions only — no I/O, so every one is unit-testable.
 *
 * Threat coverage (see docs/security.md for the full table):
 *  - Replay attacks            -> verifySignedRequest + consumeNonce
 *  - Secret key leaks          -> redactSecrets / fingerprint
 *  - ReDoS                     -> safePattern + bounded input lengths
 *  - Long-password DoS         -> validatePasswordStrength (byte cap, no truncation)
 *  - Password guessing         -> validatePasswordStrength (length floor + blocklist,
 *                                no composition rules, see the note at the return)
 *  - Injection (SQL/Cypher/XSS)-> escapeLikePattern, htmlEscape, detectTemplateInjection
 *  - Clipboard/paste-jacking   -> sanitizeUntrustedText (bidi & zero-width stripping)
 *  - Info leakage              -> safeErrorMessage via errors.ts
 */

/* ==========================================================================
 * Crypto helpers (WebCrypto: available in Deno, Node >= 20 and browsers)
 * ========================================================================== */

function subtle(): SubtleCrypto {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) {
    throw new Error('WebCrypto unavailable in this runtime')
  }
  return c.subtle
}

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  return toHex(await subtle().digest('SHA-256', data))
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await subtle().sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

/**
 * Length-independent comparison. JavaScript cannot promise true constant-time
 * execution, but this avoids the early-exit that makes naive `===` comparisons
 * exploitable, and it is used only for low-frequency checks (signature + nonce).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aLen = a.length
  const bLen = b.length
  const max = Math.max(aLen, bLen)
  let diff = aLen ^ bLen
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i % (aLen || 1)) || 0) ^ (b.charCodeAt(i % (bLen || 1)) || 0)
  }
  return diff === 0
}

/** Random hex token for nonces / request ids / idempotency keys. */
export function randomToken(bytes = 16): string {
  const arr = new Uint8Array(bytes)
  ;(globalThis as { crypto: Crypto }).crypto.getRandomValues(arr)
  return toHex(arr)
}

/* ==========================================================================
 * Replay-attack protection
 * ========================================================================== */

export interface SignedRequestParts {
  method: string
  /** Path only, no query string, e.g. "/functions/v1/mentor-chat". */
  path: string
  body: string
  timestampMs: number
  nonce: string
  /** Optional idempotency key for write operations. */
  requestId?: string
}

/**
 * Canonical string that both client and server hash. Field order is fixed so a
 * proxy cannot reorder it, and the body is included so a captured signature
 * cannot be replayed with different content.
 */
export function canonicalRequestString(parts: SignedRequestParts): string {
  return [parts.method.toUpperCase(), parts.path, String(parts.timestampMs), parts.nonce, parts.body].join('\n')
}

export function buildRequestSignature(secret: string, parts: SignedRequestParts): Promise<string> {
  return hmacSha256Hex(secret, canonicalRequestString(parts))
}

export interface VerifySignatureOptions {
  secret: string
  parts: SignedRequestParts
  signature: string
  maxSkewMs: number
  nowMs: number
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: 'stale' | 'future' | 'mismatch' | 'malformed' }

/**
 * Rejects replayed or tampered client requests:
 *  1. the timestamp must be inside a small window (default 120 s),
 *  2. the signature must match the canonical string (constant-time compare),
 *  3. the nonce must be unused — the caller enforces this with a shared store
 *     (see rateLimit.ts `NonceStore`), because an in-memory set would not be
 *     shared across Edge Function instances.
 */
export async function verifySignedRequest(options: VerifySignatureOptions): Promise<SignatureVerdict> {
  const { secret, parts, signature, maxSkewMs, nowMs } = options
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: 'malformed' }
  if (!Number.isFinite(parts.timestampMs) || parts.nonce.length < 8) return { ok: false, reason: 'malformed' }

  const skew = nowMs - parts.timestampMs
  if (skew > maxSkewMs) return { ok: false, reason: 'stale' }
  if (-skew > maxSkewMs) return { ok: false, reason: 'future' }

  const expected = await buildRequestSignature(secret, parts)
  if (!constantTimeEqual(expected, signature.toLowerCase())) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}

/** Shared contract so replay protection works across instances. */
export interface NonceStore {
  /** Returns false when the nonce was already used (i.e. a replay). */
  claim(nonce: string, expiresInMs: number): Promise<boolean>
}

/* ==========================================================================
 * Input hygiene
 * ========================================================================== */

/** Unicode direction/format characters used for paste-jacking and spoofing. */
const BIDI_AND_INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF]/g
/** C0/C1 control characters except \n and \t. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/**
 * Neutralises untrusted text before it is stored, displayed or sent to a model:
 *  - removes invisible/bidirectional override characters (clipboard & spoofing),
 *  - removes control characters,
 *  - collapses excessive whitespace/newlines,
 *  - enforces a hard length cap.
 *
 * It deliberately does NOT strip punctuation: the caller decides whether to
 * escape for HTML at render time (React does this by default).
 */
export function sanitizeUntrustedText(input: string, maxLength = 4000): string {
  let out = String(input)
  out = out.replace(BIDI_AND_INVISIBLE, '')
  out = out.replace(CONTROL_CHARS, '')
  out = out.replace(/\r\n?/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.replace(/[ \t]{3,}/g, '  ')
  out = out.trim()
  if (out.length > maxLength) out = out.slice(0, maxLength)
  return out
}

export function stripBidiAndFormat(input: string): string {
  return String(input).replace(BIDI_AND_INVISIBLE, '')
}

export function hasInvisibleOrBidi(input: string): boolean {
  return BIDI_AND_INVISIBLE.test(String(input))
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
}

/**
 * Escapes HTML metacharacters. React escapes by default, so this exists for the
 * few places where we build markup strings ourselves (service worker fallback,
 * plain-text exports) and for defence in depth.
 */
export function htmlEscape(input: string): string {
  return String(input).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/**
 * Server-Side Template Injection guard.
 *
 * GraphMentor never evaluates templates from user input, but user text flows
 * into AI prompts and generated documents, so we detect template/expression
 * markers and treat the input as data: markers are reported (so the UI can warn)
 * and stripped before the value is used in any template-like context.
 */
const TEMPLATE_MARKERS: RegExp[] = [
  /\{\{[\s\S]{0,200}?\}\}/, // Jinja / Handlebars / Vue / Twig
  /\$\{[\s\S]{0,200}?\}/, // JS template literal
  /<%[\s\S]{0,200}?%>/, // ERB / EJS / ASP
  /#\{[\s\S]{0,200}?\}/, // Ruby / EL-ish
  /\{[A-Za-z_$][\w$.[\]()]*\}/, // Python str.format / .NET
  /\[\[[\s\S]{0,200}?\]\]/, // Angular-ish / wiki templates
  /\b(\$|@)\{[^}]{0,200}\}/, // shell / LaTeX-ish
]

export interface TemplateMarkerReport {
  found: boolean
  markers: string[]
  cleaned: string
}

export function detectTemplateInjection(input: string): TemplateMarkerReport {
  const text = String(input)
  const markers: string[] = []
  for (const re of TEMPLATE_MARKERS) {
    const m = text.match(re)
    if (m) markers.push(m[0].slice(0, 60))
  }
  return { found: markers.length > 0, markers, cleaned: markers.length > 0 ? stripTemplateMarkers(text) : text }
}

/** Removes template markers while keeping the surrounding prose readable. */
export function stripTemplateMarkers(input: string): string {
  let out = String(input)
  for (const re of TEMPLATE_MARKERS) {
    out = out.replace(new RegExp(re.source, 'g'), ' ')
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Instruction-override detection for text that will be embedded in an AI prompt
 * (e.g. a resource title pasted by a user, or a note field). External content is
 * data, never instructions — this flags the common patterns so the caller can
 * neutralise them before they reach a model.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore (all |any )?(previous|prior|above|earlier) (instructions|prompts|rules)\b/i,
  /\bdisregard (the )?(system|previous|safety) (prompt|instructions|rules)\b/i,
  /\byou are now\b.{0,40}\b(dan|jailbreak|unrestricted|no rules)\b/i,
  /\b(system|developer)\s*(prompt|message)\s*[:=]/i,
  /\b(reveal|print|leak|expose)\b.{0,30}\b(api[_ -]?key|secret|password|token|connection string)\b/i,
  /\bexecute (this )?(cypher|sql|query)\b/i,
  /\bnew instructions?\s*:/i,
]

export interface PromptSafetyReport {
  suspicious: boolean
  matches: string[]
  cleaned: string
}

export function screenForPromptInjection(input: string): PromptSafetyReport {
  const text = String(input)
  const matches: string[] = []
  for (const re of PROMPT_INJECTION_PATTERNS) {
    const m = text.match(re)
    if (m) matches.push(m[0].slice(0, 80))
  }
  let cleaned = text
  if (matches.length > 0) {
    for (const re of PROMPT_INJECTION_PATTERNS) {
      cleaned = cleaned.replace(new RegExp(re.source, 'gi'), '[removed-instruction-like-text]')
    }
  }
  return { suspicious: matches.length > 0, matches, cleaned }
}

/* ==========================================================================
 * ReDoS protection
 * ========================================================================== */

/**
 * Heuristic rejection of catastrophic-backtracking patterns.
 *
 * JavaScript has no regex execution timeout, so the defence is layered:
 *  1. reject nested quantifiers / backreferences here,
 *  2. cap the pattern length,
 *  3. cap the input length before matching (see safeTest),
 *  4. never accept a pattern from an untrusted source: user input is escaped
 *     into a literal with escapeRegExp, never compiled directly.
 */
/**
 * Every regex this module ships, exposed for adversarial review.
 *
 * ReDoS defence that is never tested is a comment, not a control. The unit suite
 * runs each of these against a hostile corpus under a wall-clock bound, so a
 * future pattern that backtracks catastrophically fails the build instead of
 * hanging a request. Names are included so a failure says which pattern.
 */
export function listSecurityPatterns(): Array<{ name: string; pattern: RegExp }> {
  return [
    { name: 'bidi-and-invisible', pattern: BIDI_AND_INVISIBLE },
    { name: 'control-characters', pattern: CONTROL_CHARS },
    ...TEMPLATE_MARKERS.map((pattern, index) => ({ name: `template-marker-${index}`, pattern })),
    ...PROMPT_INJECTION_PATTERNS.map((pattern, index) => ({ name: `prompt-injection-${index}`, pattern })),
  ]
}

export function isUnsafePattern(pattern: string): boolean {
  if (pattern.length > 200) return true
  // Nested quantifier on the same group: (a+)+, (a*)*, (\w+){2,}, (.*)+
  if (/(\((?:[^()\\]|\\.)*[*+][^()\\]*\))[*+{]/.test(pattern)) return true
  // Quantified dot-star next to another quantified group
  if (/\(\.\*\)[*+]/.test(pattern)) return true
  // Backreferences enable exponential matching in some engines
  if (/\\[1-9]/.test(pattern)) return true
  return false
}

export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SafeTestOptions {
  maxPatternLength?: number
  maxInputLength?: number
}

export function safePatternTest(pattern: string, input: string, options: SafeTestOptions = {}): boolean {
  const { maxPatternLength = 200, maxInputLength = 500 } = options
  if (pattern.length > maxPatternLength) return false
  if (input.length > maxInputLength) return false
  if (isUnsafePattern(pattern)) return false
  try {
    return new RegExp(pattern, 'i').test(input)
  } catch {
    return false
  }
}

/**
 * Builds a case-insensitive "contains" pattern from an untrusted search term.
 * The term is escaped, so a hostile string like `(a+)+$` becomes a literal.
 */
export function buildSafeSearchPattern(term: string, maxLength = 80): string {
  const clean = sanitizeUntrustedText(term, maxLength)
  return escapeRegExp(clean)
}

/** Escapes Cypher/LIKE wildcards so a user cannot widen a search accidentally. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/* ==========================================================================
 * URL / link safety
 * ========================================================================== */

const ALLOWED_RESOURCE_HOSTS = [
  'developer.mozilla.org',
  'docs.python.org',
  'www.python.org',
  'learn.microsoft.com',
  'docs.oracle.com',
  'ocw.mit.edu',
  'openstax.org',
  'www.khanacademy.org',
  'cs50.harvard.edu',
  'www.freecodecamp.org',
  'git-scm.com',
  'www.arduino.cc',
  'docs.arduino.cc',
  'www.raspberrypi.com',
  'scikit-learn.org',
  'numpy.org',
  'pandas.pydata.org',
  'pytorch.org',
  'www.tensorflow.org',
  'jupyter.org',
  'react.dev',
  'nodejs.org',
  'www.typescriptlang.org',
  'neo4j.com',
  'kubernetes.io',
  'docs.docker.com',
  'www.terraform.io',
  'developer.hashicorp.com',
  'owasp.org',
  'www.cisa.gov',
  'csrc.nist.gov',
  'nptel.ac.in',
  'spoken-tutorial.org',
  'swayam.gov.in',
  'www.iitb.ac.in',
  'archive.org',
  'github.com',
  'www.autodesk.com',
  'www.freecad.org',
  'openscad.org',
  'www.onshape.com',
  'www.mathworks.com',
  'www.gnu.org',
  'ethereum.org',
  'www.energy.gov',
  'www.nrel.gov',
  'www.iso.org',
  'www.w3.org',
  'developers.google.com',
  'web.dev',
  'sqlite.org',
  'postgresql.org',
  'www.postgresql.org',
  'www.sqlite.org',
  'duckdb.org',
  'cython.org',
  'matplotlib.org',
  'seaborn.pydata.org',
  'docs.ros.org',
  'www.ros.org',
  'gazebosim.org',
  'www.tinkercad.com',
  'www.kicad.org',
  'components101.com',
  'www.allaboutcircuits.com',
  'circuitverse.org',
  'en.wikipedia.org',
  'simple.wikipedia.org',
  'www.faa.gov',
  'www.osha.gov',
] as const

export type UrlVerdict =
  | { ok: true; url: string; host: string; needsManualReview: boolean }
  | { ok: false; reason: string }

/**
 * Validates a resource/link URL before it is stored or rendered as an anchor:
 *  - https only (no http, no data:, no javascript:, no file:),
 *  - no embedded credentials (`https://user:pass@example.com`),
 *  - no IP-literal or localhost targets,
 *  - host on the curated allow-list (unlisted hosts are allowed but flagged for
 *    manual review, which is what the UI shows as "unverified").
 */
export function validateResourceUrl(raw: string, options: { allowUnlistedHosts?: boolean } = {}): UrlVerdict {
  const { allowUnlistedHosts = true } = options
  const value = String(raw ?? '').trim()
  if (!value) return { ok: false, reason: 'empty' }
  if (value.length > 2048) return { ok: false, reason: 'too-long' }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'embedded-credentials' }

  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    !host.includes('.') ||
    host.endsWith('.') ||
    Boolean(parsed.port)
  ) {
    return { ok: false, reason: 'private-host' }
  }

  const listed = ALLOWED_RESOURCE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  if (!listed && !allowUnlistedHosts) return { ok: false, reason: 'host-not-allowlisted' }

  return { ok: true, url: parsed.toString(), host, needsManualReview: !listed }
}

export function isTrustedResourceHost(host: string): boolean {
  const h = host.toLowerCase()
  return ALLOWED_RESOURCE_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

export function listTrustedResourceHosts(): readonly string[] {
  return ALLOWED_RESOURCE_HOSTS
}

/* ==========================================================================
 * Passwords — long-password DoS and weak-password control
 * ========================================================================== */

export interface PasswordLimits {
  minLength: number
  /**
   * Upper bound in UTF-8 *bytes*. Supabase Auth uses bcrypt, which considers only
   * the first 72 bytes. Rejecting longer input (instead of silently truncating)
   * prevents both the long-password CPU/DoS pattern and the surprise that two
   * different long passwords authenticate the same account.
   */
  maxBytes: number
}

export const DEFAULT_PASSWORD_LIMITS: PasswordLimits = { minLength: 10, maxBytes: 72 }

/**
 * The ceiling on password *input*, separate from the policy limit above.
 *
 * `maxBytes: 72` is the policy: passwords longer than bcrypt's window are
 * **rejected** with an explanation. This ceiling is the DoS guard. It exists
 * because every hash of every password costs the provider CPU, and a sign-in
 * endpoint that accepts a megabyte of "password" hands an attacker a cheap way
 * to burn someone else's compute (and to make our own sign-in path a
 * bandwidth amplifier). One kilobyte is far beyond any real passphrase and far
 * below anything worth hashing twice.
 *
 * It is enforced in three places, because one is not enough:
 *   1. the sign-in form refuses locally, before any network call,
 *   2. the client refuses again in `auth.ts` (belt and braces — the UI is not a
 *      security boundary),
 *   3. the `auth-guard` Edge Function refuses and *counts the attempt*, so a
 *      caller that bypasses the UI still spends its rate-limit budget and never
 *      reaches Supabase Auth's hashing.
 */
export const PASSWORD_INPUT_CEILING_BYTES = 1024

/** True when a password is too large to even attempt (DoS guard, not policy). */
export function passwordExceedsInputCeiling(password: string): boolean {
  return utf8ByteLength(password) > PASSWORD_INPUT_CEILING_BYTES
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456789',
  '12345678',
  'qwertyuiop',
  'letmein123',
  'iloveyou',
  'admin12345',
  'welcome123',
  'graphmentor',
  'engineering',
  'student123',
])

export interface PasswordCheck {
  ok: boolean
  /** Reasons are safe to display; they never echo the password. */
  problems: string[]
  /** Relative cost indicator 0..1 — used to render a strength meter. */
  strength: number
  /** How many character classes are present (0–4). Advisory only, never a rule. */
  classes: number
}

export function utf8ByteLength(input: string): number {
  let bytes = 0
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp <= 0x7f) bytes += 1
    else if (cp <= 0x7ff) bytes += 2
    else if (cp <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

export function validatePasswordStrength(
  password: string,
  limits: PasswordLimits = DEFAULT_PASSWORD_LIMITS,
): PasswordCheck {
  const problems: string[] = []
  const bytes = utf8ByteLength(password)

  if (password.length < limits.minLength) {
    problems.push(`Use at least ${limits.minLength} characters.`)
  }
  if (bytes > limits.maxBytes) {
    problems.push(`Use at most ${limits.maxBytes} bytes (about ${limits.maxBytes} ASCII characters).`)
  }
  if (/^(.)\1+$/.test(password)) problems.push('Use more than one repeated character.')
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(password)) {
    problems.push('Avoid keyboard or number sequences.')
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('This password appears in common password lists.')

  // Cost estimate only — not a security guarantee, and the UI labels it as a hint.
  let classes = 0
  if (/[a-z]/.test(password)) classes++
  if (/[A-Z]/.test(password)) classes++
  if (/\d/.test(password)) classes++
  if (/[^\w\s]/.test(password)) classes++
  const lengthScore = Math.min(1, password.length / 20)
  const strength = Math.min(1, lengthScore * 0.6 + (classes / 4) * 0.4)

  /*
   * Class mixing is deliberately NOT a requirement here, only a strength input.
   *
   * Requiring three classes rejects "correct horse battery staple" while
   * accepting "Password1!" — it selects for the passwords that crack first.
   * Current guidance (NIST SP 800-63B §5.1.1.2) calls for length and a
   * blocklist check, not composition rules, and the blocklist check is above.
   * The byte cap protects the hash cost; the length floor protects the search
   * space. The class count is returned so the UI can *advise* without gating.
   */
  return { ok: problems.length === 0, problems, strength: Number(strength.toFixed(2)), classes }
}

/* ==========================================================================
 * Secret redaction (logging safety)
 * ========================================================================== */

const SECRET_KEY_HINTS = /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|service[_-]?role|session|cookie|signature|nonce)/i
const REDACTED = '[redacted]'

/** Keys that look like secrets, plus common credential shapes inside values. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 6) return '[depth-limit]' as unknown as T
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    return redactSecretsInString(value) as unknown as T
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_HINTS.test(k) ? REDACTED : redactSecrets(v, depth + 1)
    }
    return out as unknown as T
  }
  if (typeof value === 'function') return '[function]' as unknown as T
  return value
}

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9]{12,}\b/g, 'sk-[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIza[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[jwt-redacted]'],
  [/\bneo4j(\+s)?:\/\/[^\s"']+/gi, 'neo4j://[redacted]'],
  [/\b(?:postgres|postgresql):\/\/[^\s"']+/gi, 'postgresql://[redacted]'],
  [/\bservice_role\b/gi, 'service_role'],
]

export function redactSecretsInString(input: string): string {
  let out = input
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement)
  return out
}

/**
 * One-way fingerprint of a secret for logs: lets an operator confirm *which* key
 * was used without storing the key. Never reversible.
 */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await sha256Hex(`gm-fingerprint:${secret}`)
  return digest.slice(0, 8)
}

/* ==========================================================================
 * Content-Type / body guards
 * ========================================================================== */

export const MAX_JSON_BODY_BYTES = 32 * 1024 // 32 KB is plenty for chat + roadmap payloads

export function isJsonContentType(header: string | null): boolean {
  if (!header) return false
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(header.trim())
}

/** Rejects NUL bytes, over-long bodies and bodies that are not valid UTF-8 JSON. */
export function assertSafeBodyText(text: string, maxBytes = MAX_JSON_BODY_BYTES): void {
  const size = utf8ByteLength(text)
  if (size > maxBytes) {
    const err = new Error('payload too large')
    err.name = 'PayloadTooLarge'
    throw err
  }
  if (text.includes('\u0000')) {
    const err = new Error('nul byte')
    err.name = 'MalformedBody'
    throw err
  }
}


