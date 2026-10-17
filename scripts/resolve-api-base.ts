/**
 * resolve-api-base — one source of truth for the backend URL a build talks to.
 *
 * The frontend needs exactly one build-time value: the public base URL of the
 * backend that serves the shared function contract (`<origin>/functions/v1`).
 * Two places used to be able to supply it, and they could disagree:
 *
 *   1. the `VITE_API_BASE_URL` environment variable (a repository Actions
 *      variable in the Pages workflow, or a shell variable locally), and
 *   2. `config/production-backend.json`, a reviewed file in this repository.
 *
 * The environment variable still wins — it is the documented knob and it can be
 * changed without a commit — but the committed file means a build is
 * reproducible from the repository alone, and that the URL embedded in a
 * published artifact is visible in a pull request instead of hidden in a
 * settings page. When both are set they must agree, because a build that
 * silently prefers one of them is how a site ends up pointing at a backend
 * nobody is looking at.
 *
 * Rules enforced here (and only here, so the build and the workflow cannot
 * disagree about them):
 *
 *   - an absolute URL is required; a relative base is allowed only for a
 *     same-origin deployment and only outside a production build;
 *   - a production build must use https and must not point at localhost;
 *   - the base must address the shared function contract: it ends in
 *     `/functions/v1`. The Node backend genuinely serves that contract
 *     (`server/graphApi.ts` mounts every function route under `/functions/v1/`),
 *     so this is true for the self-hosted backend as well as for Supabase Edge
 *     Functions — it is not a Supabase-only shape;
 *   - the URL must not carry credentials.
 *
 * CLI:
 *   npx tsx scripts/resolve-api-base.ts            # human-readable summary
 *   npx tsx scripts/resolve-api-base.ts --json     # machine-readable
 *   npx tsx scripts/resolve-api-base.ts --check    # exit 1 when invalid
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BackendKind = 'none' | 'node' | 'supabase'

export interface BackendConfigFile {
  /** The public API base, e.g. "https://api.example.com/functions/v1". */
  apiBaseUrl?: string
  /** Which backend contract the base addresses. */
  kind?: BackendKind
  /** Free-text note for reviewers. */
  note?: string
}

export interface ResolveOptions {
  env: Record<string, string | undefined>
  /** Production builds reject localhost and other non-public targets. */
  production?: boolean
  /** Injected by tests; defaults to reading the committed file. */
  readConfigFile?: () => BackendConfigFile | null
}

export interface Resolution {
  /** The base URL to embed, or "" for a demo build. */
  apiBaseUrl: string
  kind: BackendKind
  /** Where the value came from. */
  source: 'env' | 'config-file' | 'none'
  /** Human-readable reasons the value is not usable. Empty means it is fine. */
  problems: string[]
}

const here = dirname(fileURLToPath(import.meta.url))
export const BACKEND_CONFIG_PATH = resolve(here, '..', 'config', 'production-backend.json')

/** The function contract both backends implement. */
export const FUNCTION_PREFIX = '/functions/v1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

export function readBackendConfigFile(path: string = BACKEND_CONFIG_PATH): BackendConfigFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BackendConfigFile
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** A relative base such as "/functions/v1" means "same origin as the page". */
function isRelativeBase(value: string): boolean {
  return value.startsWith('/')
}

export function resolveApiBase(options: ResolveOptions): Resolution {
  const problems: string[] = []
  const production = options.production ?? false
  const fromEnv = (options.env.VITE_API_BASE_URL ?? '').trim()
  const file = options.readConfigFile ? options.readConfigFile() : readBackendConfigFile()
  const fromFile = (file?.apiBaseUrl ?? '').trim()

  if (fromEnv && fromFile && fromEnv !== fromFile) {
    problems.push(
      'VITE_API_BASE_URL and config/production-backend.json disagree. ' +
        `The environment says "${fromEnv}" and the committed file says "${fromFile}". ` +
        'Make them the same, or unset one of them.',
    )
  }

  const value = fromEnv || fromFile
  const source: Resolution['source'] = fromEnv ? 'env' : fromFile ? 'config-file' : 'none'
  const declaredKind = file?.kind ?? 'none'

  if (!value) {
    // A demo build is a legitimate deployment: the app runs on the bundled
    // dataset and labels itself DEMO DATA.
    return { apiBaseUrl: '', kind: 'none', source: 'none', problems }
  }

  if (isRelativeBase(value)) {
    if (production) {
      problems.push('A production build must use an absolute https:// backend URL, not a same-origin path.')
      return { apiBaseUrl: value, kind: declaredKind === 'none' ? 'node' : declaredKind, source, problems }
    }
    if (!value.startsWith(FUNCTION_PREFIX)) {
      problems.push(`A relative API base must be "${FUNCTION_PREFIX}" (the function contract both backends serve).`)
    }
    return { apiBaseUrl: value, kind: 'node', source, problems }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    problems.push(`"${value}" is not a valid URL.`)
    return { apiBaseUrl: value, kind: declaredKind === 'none' ? 'node' : declaredKind, source, problems }
  }

  if (url.username || url.password) {
    problems.push('The API base URL must not contain credentials.')
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname)
  if (url.protocol === 'http:' && !(isLocal && !production)) {
    problems.push('The API base URL must use https://.')
  }
  if (production && isLocal) {
    problems.push('A production build must not point at localhost.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith(FUNCTION_PREFIX)) {
    problems.push(
      `The API base URL must end in "${FUNCTION_PREFIX}": the frontend appends the function name ` +
        '(for example get-careers), and both the Node backend and the Supabase Edge Functions serve that contract.',
    )
  }

  const kind: BackendKind = url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in')
    ? 'supabase'
    : 'node'
  if (declaredKind !== 'none' && declaredKind !== kind) {
    problems.push(
      `config/production-backend.json declares the backend as "${declaredKind}", but "${url.hostname}" ` +
        `is addressed as "${kind}".`,
    )
  }

  return { apiBaseUrl: `${url.origin}${path}`, kind, source, problems }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function main(): void {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const check = args.includes('--check')
  const production = args.includes('--production') || args.includes('--check')
  const resolution = resolveApiBase({ env: process.env, production })

  if (asJson) {
    console.log(JSON.stringify(resolution, null, 2))
  } else {
    console.log(`API base: ${resolution.apiBaseUrl || '(none — demo build)'}`)
    console.log(`Backend: ${resolution.kind}`)
    console.log(`Source:  ${resolution.source}`)
    for (const problem of resolution.problems) console.log(`Problem: ${problem}`)
  }
  if (check && resolution.problems.length > 0) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
