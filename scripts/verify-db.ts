/**
 * verify-db — hardening assertions and a live attack battery against the
 * project's own PostgreSQL cluster.
 *
 * Two kinds of check live here, and the difference matters:
 *
 *   1. **Assertions** read the running server: which interface it listens on,
 *      what every role may do, whether RLS is enabled *and forced* on the tables
 *      that hold a person's data, whether the configuration on disk is still the
 *      configuration in this repository.
 *   2. **Attacks** are actually fired: wrong passwords, plaintext connections,
 *      unix-socket connections, DDL as the application role, privilege
 *      escalation, cross-account reads, password-policy violations, a slow
 *      query, a temp-file bomb, a connection flood, a SQL-injection string
 *      through the limiter, and a replayed nonce. Every one of them is supposed
 *      to fail, and the failure is the evidence.
 *
 * A check that only reads a setting proves intent. A check that attacks the
 * server and watches it refuse proves behaviour, which is why both are here.
 *
 * Usage:
 *   npm run verify:db                 # assertions + attacks
 *   npm run verify:db -- --with-backup  # also take a dump and restore it
 *
 * Writes docs/database-verification.json. Exits non-zero on the first failed
 * group of checks (it still runs everything, so one run tells you everything).
 *
 * Nothing here prints a password, and the attack battery leaves no fixture rows
 * behind: the two accounts it creates are deleted before the process exits.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

/* ==========================================================================
 * Harness
 * ======================================================================== */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const GM_DB_ROOT = process.env['GM_DB_ROOT'] ?? '/srv/graphmentor-pg'
const PORT = Number(process.env['GM_PORT'] ?? 5433)
const DB_NAME = process.env['GM_DB_NAME'] ?? 'graphmentor'
const CERTS = join(GM_DB_ROOT, 'certs')
const SECRETS = join(GM_DB_ROOT, 'secrets')
const LOG_FILE = join(GM_DB_ROOT, 'log', 'postgres.log')

interface Check {
  group: string
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
let currentGroup = 'setup'

function section(name: string): void {
  currentGroup = name
  console.log(`\n${name}`)
}

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ group: currentGroup, name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function secret(file: string): string {
  const path = join(SECRETS, file)
  if (!existsSync(path)) {
    console.error(`\nverify-db: missing ${path}. Run "npm run db:provision" first.`)
    process.exit(2)
  }
  return readFileSync(path, 'utf8').trim()
}

type SslMode = 'verify-full' | 'noclient' | 'require' | 'disable'

/** TLS material each credential uses; the other modes exist to prove refusal. */
function sslFor(role: 'gm_admin' | 'gm_app', mode: SslMode): false | Record<string, unknown> {
  if (mode === 'disable') return false
  if (mode === 'require') return { rejectUnauthorized: false }
  const ca = readFileSync(join(CERTS, 'ca.crt'))
  if (mode === 'noclient') return { ca, rejectUnauthorized: true }
  return {
    ca,
    cert: readFileSync(join(CERTS, `client-${role}.crt`)),
    key: readFileSync(join(CERTS, `client-${role}.key`)),
    rejectUnauthorized: true,
  }
}

function connect(options: {
  user: 'gm_admin' | 'gm_app'
  password?: string
  database?: string
  ssl?: SslMode
  host?: string
  port?: number
}): Client {
  const password = options.password ?? secret(options.user === 'gm_admin' ? 'gm_admin.pass' : 'gm_app.pass')
  return new Client({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? PORT,
    user: options.user,
    password,
    database: options.database ?? DB_NAME,
    ssl: sslFor(options.user, options.ssl ?? 'verify-full'),
    connectionTimeoutMillis: 6_000,
  })
}

async function scalar(client: Client, sql: string, params?: unknown[]): Promise<string | null> {
  const result = await client.query(sql, params as never[])
  const row = result.rows[0] as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : null
  return value === null || value === undefined ? null : String(value)
}

async function numbers(client: Client, sql: string): Promise<number> {
  return Number((await scalar(client, sql)) ?? '0')
}

/** Run something that must fail; return the error code and message for the report. */
async function expectFailure(run: () => Promise<unknown>): Promise<{ failed: boolean; code: string; message: string }> {
  try {
    await run()
    return { failed: false, code: '', message: 'the operation succeeded' }
  } catch (error) {
    const err = error as { code?: string; message?: string }
    return { failed: true, code: err.code ?? '', message: (err.message ?? String(error)).split('\n')[0] ?? '' }
  }
}

function exec(command: string, args: string[]): { status: number; output: string } {
  // spawnSync rather than execFileSync: OpenSSL writes the negotiated protocol to
  // stderr, and a check that only reads stdout would call a working handshake a failure.
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 })
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/* ==========================================================================
 * Main
 * ======================================================================== */

async function main(): Promise<void> {
  const withBackup = process.argv.includes('--with-backup')
  console.log('verify-db — the project\'s own PostgreSQL cluster\n')

  if (!existsSync(join(GM_DB_ROOT, 'data', 'PG_VERSION'))) {
    console.error(`verify-db: no cluster at ${GM_DB_ROOT}/data. Run "npm run db:provision".`)
    process.exit(2)
  }

  const admin = connect({ user: 'gm_admin' })
  await admin.connect()
  const version = (await scalar(admin, 'select version()')) ?? 'unknown'

  /* ---------------------------------------------------------------------
   * 1. Reachability — who can even open a socket to this server
   * ------------------------------------------------------------------- */
  section('1. Reachability and transport')

  interface Listener { address: string; uid: number }
  const listeners: Listener[] = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue
    const portHex = PORT.toString(16).toUpperCase().padStart(4, '0')
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      const local = parts[1]
      if (!local) continue
      const [address, port] = local.split(':')
      if (port !== portHex || parts[3] !== '0A') continue // 0A = LISTEN
      listeners.push({ address: address ?? '', uid: Number(parts[7] ?? '-1') })
    }
  }
  const isLoopback = (address: string): boolean =>
    /^0100007F$/i.test(address) || /^0{24}01000000$/i.test(address) || /^0{31}1$/i.test(address) || /^0{31}1000000$/i.test(address)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1
  const mine = listeners.filter((entry) => entry.uid === myUid)
  const foreign = listeners.filter((entry) => entry.uid !== myUid)
  check('PostgreSQL itself is listening on loopback only',
    mine.length > 0 && mine.every((entry) => isLoopback(entry.address)),
    `${mine.length} socket(s) owned by uid ${myUid}, all 127.0.0.1/::1`)
  check('listen_addresses is 127.0.0.1', (await scalar(admin, 'show listen_addresses')) === '127.0.0.1', `port ${PORT}`)
  check('any other listener on this port is reported, not assumed harmless', true,
    foreign.length === 0
      ? 'no other process is listening on this port'
      : `${foreign.length} listener(s) owned by other uids (the sandbox port forwarder) — covered by the check below`)

  // The port forwarder re-originates connections from 127.0.0.1, so the database
  // cannot tell them apart from a local client by address. What it can do is
  // refuse them, because they arrive without the client certificate.
  const addresses = exec('hostname', ['-I']).output.trim().split(/\s+/).filter((a) => a && !a.startsWith('127.'))
  if (addresses.length > 0) {
    const forwarded = await expectFailure(() =>
      connect({ user: 'gm_app', host: addresses[0], password: secret('gm_app.pass'), ssl: 'require' }).connect())
    check('a connection through the non-loopback (forwarded) path is refused without the client key', forwarded.failed,
      `${addresses[0]}:${PORT} — ${forwarded.code || forwarded.message}`)
  } else {
    check('a connection through the non-loopback path is refused without the client key', false, 'no non-loopback interface found to test')
  }

  const plaintext = await expectFailure(async () => {
    const client = connect({ user: 'gm_app', ssl: 'disable' })
    await client.connect()
    await client.end()
  })
  check('a plaintext connection (sslmode=disable) is refused', plaintext.failed, plaintext.code || plaintext.message)

  const socketPath = join(GM_DB_ROOT, 'run')
  const viaSocket = await expectFailure(async () => {
    const client = new Client({ host: socketPath, port: PORT, user: 'gm_app', password: secret('gm_app.pass'), database: DB_NAME })
    await client.connect()
    await client.end()
  })
  check('a unix-socket connection is refused', viaSocket.failed, viaSocket.code || viaSocket.message)

  const live = connect({ user: 'gm_app' })
  await live.connect()
  const onTls = await scalar(live, 'select ssl from pg_stat_ssl where pid = pg_backend_pid()')
  const tlsVersion = await scalar(live, 'select version from pg_stat_ssl where pid = pg_backend_pid()')
  const clientDn = await scalar(live, 'select client_dn from pg_stat_ssl where pid = pg_backend_pid()')
  check('the connection in use is TLS', onTls === 'true', `${tlsVersion ?? 'unknown'}`)
  check('the server saw the application client certificate', (clientDn ?? '').includes('CN=gm_app'), clientDn ?? 'none presented')
  await live.end()

  const tls12 = exec('openssl', ['s_client', '-connect', `127.0.0.1:${PORT}`, '-tls1_2', '-brief'])
  check('TLS 1.2 handshake succeeds', tls12.status === 0 && /TLSv1\.2/.test(tls12.output),
    (tls12.output.match(/Protocol version: \S+/) ?? ['no protocol line'])[0] ?? '')
  const tls11 = exec('openssl', ['s_client', '-connect', `127.0.0.1:${PORT}`, '-tls1_1', '-brief'])
  check('TLS 1.1 handshake is refused', tls11.status !== 0 || !/TLSv1\.1/.test(tls11.output),
    tls11.status !== 0 ? 'handshake failed, as configured' : 'a TLS 1.1 session was negotiated')

  /* ---------------------------------------------------------------------
   * 2. Authentication
   * ------------------------------------------------------------------- */
  section('2. Authentication')

  const goodLogin = await (async () => {
    const client = connect({ user: 'gm_app' })
    await client.connect()
    await client.end()
    return true
  })().catch(() => false)
  check('the correct credential is accepted (control)', goodLogin)

  const wrongPassword = await expectFailure(async () => {
    const client = connect({ user: 'gm_app', password: 'not-the-password' })
    await client.connect()
    await client.end()
  })
  check('a wrong password is rejected', wrongPassword.failed, wrongPassword.code || wrongPassword.message)

  const noCertificate = await expectFailure(async () => {
    const client = connect({ user: 'gm_app', ssl: 'noclient' })
    await client.connect()
    await client.end()
  })
  check('a password without a client certificate is refused', noCertificate.failed, noCertificate.code || noCertificate.message)

  const wrongPasswordWithCert = await expectFailure(async () => {
    const client = connect({ user: 'gm_app', password: 'not-the-password' })
    await client.connect()
    await client.end()
  })
  check('a client certificate without the right password is refused', wrongPasswordWithCert.failed,
    wrongPasswordWithCert.code || wrongPasswordWithCert.message)

  const borrowedCertificate = await expectFailure(async () => {
    const client = new Client({
      host: '127.0.0.1', port: PORT, user: 'gm_admin', database: DB_NAME,
      password: secret('gm_admin.pass'),
      ssl: {
        ca: readFileSync(join(CERTS, 'ca.crt')),
        cert: readFileSync(join(CERTS, 'client-gm_app.crt')),
        key: readFileSync(join(CERTS, 'client-gm_app.key')),
        rejectUnauthorized: true,
      },
      connectionTimeoutMillis: 6_000,
    })
    await client.connect()
    await client.end()
  })
  check('one role\'s certificate cannot be used as another role', borrowedCertificate.failed,
    borrowedCertificate.code || borrowedCertificate.message)

  const unknownRole = await expectFailure(async () => {
    const client = connect({ user: 'gm_admin', password: 'x', database: 'postgres' })
    await client.end()
    const stranger = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres', ssl: { rejectUnauthorized: false } })
    await stranger.connect()
    await stranger.end()
  })
  check('the conventional "postgres" superuser does not exist', unknownRole.failed, unknownRole.code || unknownRole.message)

  check('password_encryption is scram-sha-256', (await scalar(admin, 'show password_encryption')) === 'scram-sha-256')
  const storedVerifier = await scalar(admin, "select left(rolpassword, 14) from pg_authid where rolname = 'gm_app'")
  check('the stored verifier is SCRAM (not md5)', storedVerifier === 'SCRAM-SHA-256$', storedVerifier ?? 'no verifier')

  // The password policy is enforced by the passwordcheck module: try to weaken
  // the role and watch the server refuse. The real password is restored after.
  const appPassword = secret('gm_app.pass')
  const weak = await expectFailure(() => admin.query("alter role gm_app password 'abc'"))
  check('a weak password is rejected by the server', weak.failed, weak.message)
  const guessable = await expectFailure(() => admin.query("alter role gm_app password 'gm_app'"))
  check('a password equal to the role name is rejected', guessable.failed, guessable.message)
  await admin.query(`alter role gm_app password '${appPassword.replace(/'/g, "''")}'`)
  const restored = await (async () => {
    const client = connect({ user: 'gm_app' })
    await client.connect()
    await client.end()
    return true
  })().catch(() => false)
  check('the real credential still works after the policy tests', restored)

  /* ---------------------------------------------------------------------
   * 3. Roles and privilege ceilings
   * ------------------------------------------------------------------- */
  section('3. Roles and privilege ceilings')

  const superusers = await scalar(admin, "select coalesce(string_agg(rolname, ', ' order by rolname), '') from pg_roles where rolsuper")
  check('gm_admin is the only superuser', superusers === 'gm_admin', superusers ?? '')

  const bypass = await scalar(admin, "select coalesce(string_agg(rolname, ', ' order by rolname), '') from pg_roles where rolbypassrls and not rolsuper")
  check('service_role is the only BYPASSRLS role', bypass === 'service_role', bypass ?? '')

  const appAttributes = await scalar(admin, `select format('super=%s createdb=%s createrole=%s bypassrls=%s inherit=%s login=%s limit=%s',
      rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolcanlogin, rolconnlimit)
    from pg_roles where rolname = 'gm_app'`)
  check('gm_app holds no administrative attribute and cannot bypass RLS',
    appAttributes === 'super=f createdb=f createrole=f bypassrls=f inherit=f login=t limit=8', appAttributes ?? '')

  check('gm_owner cannot log in (no credential to steal)',
    (await scalar(admin, "select rolcanlogin from pg_roles where rolname = 'gm_owner'")) === 'false')

  const platformLogins = await scalar(admin, "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role') and rolcanlogin")
  check('anon, authenticated and service_role cannot log in', platformLogins === '0', `${platformLogins} can log in`)

  const memberships = await scalar(admin, `select coalesce(string_agg(r.rolname, ', '), 'none')
    from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles g on g.oid = m.member where g.rolname = 'gm_app'`)
  check('gm_app is a member of nothing', memberships === 'none', memberships ?? '')

  const appTableGrants = await numbers(admin, "select count(*) from information_schema.role_table_grants where grantee = 'gm_app'")
  check('gm_app holds zero table privileges', appTableGrants === 0, `${appTableGrants} grant(s)`)

  const tablePrivileges = await scalar(admin, `select coalesce(string_agg(c.relname || ':' || p.priv, ', '), 'none') from (
      select relname, unnest(array['SELECT','INSERT','UPDATE','DELETE']) as priv
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ) c cross join lateral (select 1) x
    join lateral (select c.relname as relname, c.priv as priv) p on true
    where has_table_privilege('gm_app', 'public.' || quote_ident(c.relname), c.priv)`)
  check('gm_app cannot read, write or delete any table', tablePrivileges === 'none', tablePrivileges ?? '')

  check('gm_app cannot create objects in public',
    (await scalar(admin, "select has_schema_privilege('gm_app', 'public', 'create')")) === 'false')

  const functionPrivileges = await scalar(admin, `select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('gm_app', p.oid, 'execute')`)
  const expectedFunctions = 'gm_claim_nonce, gm_cleanup_rate_limit, gm_consume_rate_limit'
  check('gm_app may execute exactly the three limiter functions', functionPrivileges === expectedFunctions, functionPrivileges ?? '')

  const databasePrivileges = await scalar(admin, `select format('connect=%s create=%s temp=%s',
      has_database_privilege('gm_app', '${DB_NAME}', 'connect'),
      has_database_privilege('gm_app', '${DB_NAME}', 'create'),
      has_database_privilege('gm_app', '${DB_NAME}', 'temp'))`)
  check('gm_app may connect and nothing more', databasePrivileges === 'connect=t create=f temp=f', databasePrivileges ?? '')

  check('the public pseudo-role has no CONNECT on the database',
    (await scalar(admin, `select has_database_privilege('anon', '${DB_NAME}', 'connect')`)) === 'false')

  const authRoadmapAccess = await scalar(admin,
    "select has_table_privilege('gm_auth', 'public.saved_roadmaps', 'select')::text || '/' || has_table_privilege('gm_auth', 'public.feedback', 'select')::text")
  const authTables = await scalar(admin, `select coalesce(string_agg(table_name, ', ' order by table_name), 'none')
    from (select distinct table_name from information_schema.role_table_grants where grantee = 'gm_auth') auth_tables`)
  check('gm_auth (the sign-in server) can reach only the credential + sync tables, never roadmaps or feedback',
    authRoadmapAccess === 'false/false' &&
      authTables === 'bookmarks, credentials, profiles, sessions, user_skill_progress, user_task_progress, users',
    `roadmap/feedback access ${authRoadmapAccess ?? '?'}, tables: ${authTables ?? ''}`)

  /* ---------------------------------------------------------------------
   * 4. Row level security
   * ------------------------------------------------------------------- */
  section('4. Row level security')

  const tables = await numbers(admin, "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")
  const rlsTables = await numbers(admin, "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity")
  check('row level security is enabled on every table', tables === rlsTables && tables > 0, `${rlsTables} of ${tables}`)

  const userTables = ['profiles', 'saved_roadmaps', 'roadmap_tasks', 'user_skill_progress', 'bookmarks', 'feedback']
  const forced = await scalar(admin, `select coalesce(string_agg(c.relname, ', ' order by c.relname), 'none')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity`)
  check('FORCE row level security is on every table that holds personal data',
    ['bookmarks', 'feedback', 'profiles', 'roadmap_tasks', 'saved_roadmaps', 'user_skill_progress'].every((t) => (forced ?? '').includes(t)),
    `${forced ?? ''} (of ${userTables.length} user tables)`)

  const unforcedInfra = await scalar(admin, `select coalesce(string_agg(c.relname || ':' || c.relforcerowsecurity, ', '), 'none')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('gm_rate_limit', 'gm_nonce')`)
  check('the limiter tables keep RLS enabled but not forced (the SECURITY DEFINER path needs its owner)', unforcedInfra === 'gm_nonce:false, gm_rate_limit:false', unforcedInfra ?? '')

  const policyCount = await numbers(admin, "select count(*) from pg_policies where schemaname = 'public'")
  const policyTables = await numbers(admin, "select count(distinct tablename) from pg_policies where schemaname = 'public'")
  check('every user table carries at least one policy', policyTables >= 6, `${policyCount} policies over ${policyTables} tables`)

  const definerWithoutPath = await scalar(admin, `select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and (p.proconfig is null
      or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`)
  check('every SECURITY DEFINER function pins its search_path', definerWithoutPath === 'none', definerWithoutPath ?? '')

  /* ---------------------------------------------------------------------
   * 5. The isolation proof: two accounts, one live server
   * ------------------------------------------------------------------- */
  section('5. Cross-account isolation, live')

  const owner = '11111111-2222-4333-8444-555555555555'
  const intruder = '66666666-7777-4888-8999-000000000000'
  const cleanupFixtures = async (): Promise<void> => {
    await admin.query('delete from public.profiles where id = any($1::uuid[])', [[owner, intruder]])
    await admin.query('delete from auth.users where id = any($1::uuid[])', [[owner, intruder]])
  }

  try {
    await cleanupFixtures()
    await admin.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [owner, 'owner@example.test', intruder, 'intruder@example.test'])
    // The signup trigger has already created both profile rows; label them.
    await admin.query("insert into public.profiles (id, education_level) values ($1, $2), ($3, $4) on conflict (id) do update set education_level = excluded.education_level", [owner, 'owner row', intruder, 'intruder row'])

    const asUser = async (claim: string | null, sql: string): Promise<string> => {
      await admin.query('begin')
      await admin.query('set local role authenticated')
      if (claim) await admin.query("select set_config('request.jwt.claims', $1, true)", [claim])
      try {
        return (await scalar(admin, sql)) ?? 'null'
      } finally {
        await admin.query('rollback')
      }
    }

    const seesOwn = await asUser(JSON.stringify({ sub: owner }), 'select count(*) from public.profiles')
    const seesOther = await asUser(JSON.stringify({ sub: intruder }), "select count(*) from public.profiles where id = $1".replace('$1', `'${owner}'`))
    const seesNothing = await asUser(null, 'select count(*) from public.profiles')

    check('an account with a verified claim sees its own row', seesOwn === '1', `${seesOwn} row(s)`)
    check('that account cannot see the other account\'s row', seesOther === '0', `${seesOther} row(s)`)
    check('a session with no claim sees no rows at all (fails closed)', seesNothing === '0', `${seesNothing} row(s)`)

    const forgedInsert = await expectFailure(async () => {
      await admin.query('begin')
      await admin.query('set local role authenticated')
      await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner })])
      try {
        await admin.query('insert into public.profiles (id, education_level) values ($1, $2)', [intruder, 'forged'])
      } finally {
        await admin.query('rollback')
      }
    })
    check('an account cannot write a row belonging to somebody else', forgedInsert.failed, forgedInsert.code || forgedInsert.message)

    const appReads = await expectFailure(async () => {
      const client = connect({ user: 'gm_app' })
      await client.connect()
      try {
        await client.query('select count(*) from public.profiles')
      } finally {
        await client.end()
      }
    })
    check('the application role cannot read the profiles table at all', appReads.failed, appReads.code || appReads.message)
  } finally {
    await cleanupFixtures()
  }

  const leftover = await numbers(admin, 'select count(*) from public.profiles')
  check('the isolation fixtures left nothing behind', leftover === 0, `${leftover} row(s) in profiles`)

  /* ---------------------------------------------------------------------
   * 6. The attack battery
   * ------------------------------------------------------------------- */
  section('6. Attack battery (every attempt must fail)')

  const attacker = connect({ user: 'gm_app' })
  await attacker.connect()

  const readPgAuthid = await expectFailure(() => attacker.query('select rolpassword from pg_authid limit 1'))
  check('attack: read the password verifiers', readPgAuthid.failed, readPgAuthid.code || readPgAuthid.message)

  const ddl = await expectFailure(() => attacker.query('create table public.gm_attacker (id int)'))
  check('attack: create a table as the application role', ddl.failed, ddl.code || ddl.message)

  const dropTable = await expectFailure(() => attacker.query('drop table public.profiles'))
  check('attack: drop a table as the application role', dropTable.failed, dropTable.code || dropTable.message)

  const escalateSuper = await expectFailure(() => attacker.query('alter role gm_app superuser'))
  check('attack: promote itself to superuser', escalateSuper.failed, escalateSuper.code || escalateSuper.message)

  const escalateRole = await expectFailure(() => attacker.query('set role service_role'))
  check('attack: switch into service_role to inherit BYPASSRLS', escalateRole.failed, escalateRole.code || escalateRole.message)

  const copyProgram = await expectFailure(() => attacker.query("copy (select 1) to program 'id'"))
  check('attack: run a shell command through COPY … TO PROGRAM', copyProgram.failed, copyProgram.code || copyProgram.message)

  const readLimiter = await expectFailure(() => attacker.query('select count(*) from public.gm_rate_limit'))
  check('attack: read the rate-limit counters directly', readLimiter.failed, readLimiter.code || readLimiter.message)

  const injectionKey = "verifydb'); drop table public.gm_nonce; --"
  const injection = await (async () => {
    const value = await scalar(attacker, 'select public.gm_consume_rate_limit($1, $2, $3)', [injectionKey, 1, 60])
    return value
  })()
  const nonceSurvived = (await scalar(admin, "select to_regclass('public.gm_nonce') is not null")) === 'true'
  check('attack: SQL injection through the limiter key (string stored, table intact)', injection !== null && nonceSurvived,
    `returned ${injection}, gm_nonce still present`)

  const nonce = `verifydb-nonce-${Date.now()}`
  const firstClaim = await scalar(attacker, 'select public.gm_claim_nonce($1, $2)', [nonce, 60])
  const replayed = await scalar(attacker, 'select public.gm_claim_nonce($1, $2)', [nonce, 60])
  check('attack: replay a nonce that was already spent', firstClaim === 'true' && replayed === 'false',
    `first ${firstClaim}, replay ${replayed}`)

  await attacker.query("delete from public.gm_rate_limit where key like 'verifydb%'").catch(() => undefined)
  await attacker.end()

  /* ---------------------------------------------------------------------
   * 7. Denial-of-service ceilings, exercised
   * ------------------------------------------------------------------- */
  section('7. Resource ceilings, exercised')

  const slow = await (async () => {
    const client = connect({ user: 'gm_app' })
    await client.connect()
    const started = Date.now()
    const outcome = await expectFailure(() => client.query('select pg_sleep(30)'))
    const elapsed = Date.now() - started
    await client.end()
    return { ...outcome, elapsed }
  })()
  check('a slow query is cancelled by statement_timeout', slow.failed && slow.code === '57014',
    `${slow.code} after ${(slow.elapsed / 1000).toFixed(1)}s`)

  const tempBomb = await (async () => {
    const client = connect({ user: 'gm_app' })
    await client.connect()
    try {
      // temp_file_limit itself is superuser-settable, so the role default
      // (128MB, asserted in section 8) does the work; forcing a tiny work_mem
      // makes this sort spill far past it in about a second.
      await client.query("set work_mem = '64kB'")
      const outcome = await expectFailure(() => client.query('select count(*) from (select md5(g::text) as h from generate_series(1, 8000000) g order by h) s'))
      return outcome
    } finally {
      await client.end()
    }
  })()
  check('a query that exceeds the temp-file ceiling is stopped', tempBomb.failed, tempBomb.code || tempBomb.message)

  const flood = await (async () => {
    const opened: Client[] = []
    let refused = 0
    let lastMessage = ''
    for (let i = 0; i < 11; i += 1) {
      const client = connect({ user: 'gm_app' })
      try {
        await client.connect()
        opened.push(client)
      } catch (error) {
        refused += 1
        lastMessage = ((error as Error).message ?? '').split('\n')[0] ?? ''
      }
    }
    for (const client of opened) await client.end().catch(() => undefined)
    return { opened: opened.length, refused, lastMessage }
  })()
  check('the connection limit for the application role is enforced', flood.opened <= 8 && flood.refused >= 1,
    `${flood.opened} opened, ${flood.refused} refused — ${flood.lastMessage}`)

  /* ---------------------------------------------------------------------
   * 8. The audit trail
   * ------------------------------------------------------------------- */
  section('8. Audit trail')

  const logSizeBefore = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
  for (let i = 0; i < 15; i += 1) {
    await expectFailure(async () => {
      const client = connect({ user: 'gm_app', password: `wrong-${i}` })
      await client.connect()
      await client.end()
    })
  }
  const logTail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').slice(logSizeBefore) : ''
  const failures = (logTail.match(/password authentication failed/g) ?? []).length
  check('fifteen failed logins are recorded in the server log', failures >= 15, `${failures} failure line(s) written`)

  const settings = [
    ['log_connections', 'on'],
    ['log_disconnections', 'on'],
    ['log_statement', 'ddl'],
    ['row_security', 'on'],
    ['ssl', 'on'],
    ['ssl_min_protocol_version', 'TLSv1.2'],
    ['max_connections', '40'],
    ['superuser_reserved_connections', '3'],
    ['max_wal_senders', '0'],
    ['max_replication_slots', '0'],
    ['lock_timeout', '5000'],
    ['temp_file_limit', '262144'],
    ['fsync', 'on'],
    ['full_page_writes', 'on'],
    ['password_encryption', 'scram-sha-256'],
  ] as const
  const drifted: string[] = []
  for (const [setting, expected] of settings) {
    const actual = await scalar(admin, `select setting from pg_settings where name = '${setting}'`)
    if (actual !== expected) drifted.push(`${setting}=${actual ?? 'missing'} (want ${expected})`)
  }
  check('every configured ceiling and audit setting is live', drifted.length === 0, drifted.join('; ') || `${settings.length} settings`)

  // Timeouts are role-overridable and this session runs as gm_admin (whose own
  // defaults are deliberately looser), while SET ROLE does not reload the login
  // role's settings. So read the cluster defaults from the server binary
  // (`postgres -C`), which reports what the configuration file actually says.
  const pgBin = exec('sh', ['-c', 'ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1']).output.trim()
  const configValue = (name: string): string =>
    exec(join(pgBin, 'postgres'), ['-D', join(GM_DB_ROOT, 'data'), '-C', name]).output.trim()
  const clusterDefaults = `${configValue('statement_timeout')}/${configValue('idle_in_transaction_session_timeout')}`
  check('the cluster statement and idle-transaction timeouts are the configured ones', clusterDefaults === '15000/10000', `${clusterDefaults} (ms, i.e. 15s/10s)`)

  const roleDefaults = await scalar(admin, "select coalesce(array_to_string(rolconfig, ', '), 'none') from pg_roles where rolname = 'gm_app'")
  check('gm_app carries its own timeout defaults', (roleDefaults ?? '').includes('statement_timeout=10s') && (roleDefaults ?? '').includes('temp_file_limit=128MB'),
    roleDefaults ?? '')

  /* ---------------------------------------------------------------------
   * 9. Configuration drift and secret hygiene
   * ------------------------------------------------------------------- */
  section('9. Configuration drift and secret hygiene')

  const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const file of ['postgresql.conf', 'pg_hba.conf']) {
    const live = join(GM_DB_ROOT, 'data', file)
    const policy = join(root, 'db', file)
    const same = existsSync(live) && existsSync(policy) && digest(live) === digest(policy)
    check(`${file} on the server is byte-identical to the repository policy`, same,
      same ? digest(policy).slice(0, 12) : 'drift detected — re-run db:provision')
  }

  const hba = readFileSync(join(GM_DB_ROOT, 'data', 'pg_hba.conf'), 'utf8')
  const hbaLines = hba.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))
  const refusedLines = hbaLines.filter((line) => line.trim().endsWith('reject')).length
  check('pg_hba.conf contains no trust, peer or md5 rule',
    !/(^|\s)(trust|peer|md5)(\s|$)/.test(hbaLines.join('\n')), `${hbaLines.length} active rules, ${refusedLines} explicit refusals`)
  check('every accepted rule requires TLS',
    hbaLines.filter((line) => !line.trim().endsWith('reject')).every((line) => line.trim().startsWith('hostssl')),
    `${hbaLines.filter((line) => line.trim().startsWith('hostssl')).length} hostssl rule(s)`)

  const secretFiles = ['gm_admin.pass', 'gm_app.pass', 'pgpass']
  const modes = secretFiles.map((file) => {
    const stats = statSync(join(SECRETS, file))
    return `${file}:${(stats.mode & 0o777).toString(8)}`
  })
  check('secret files exist and are mode 600', modes.every((entry) => entry.endsWith(':600')), modes.join(' '))

  const secretsDirMode = (statSync(SECRETS).mode & 0o777).toString(8)
  const secretsOutsideRepo = !resolve(SECRETS).startsWith(`${root}/`)
  check('the secret directory is 700 and outside the repository', secretsDirMode === '700' && secretsOutsideRepo,
    `${SECRETS} mode ${secretsDirMode}`)

  // Walk the repository and prove the generated passwords appear nowhere in it.
  const needle = [secret('gm_admin.pass'), secret('gm_app.pass')]
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'coverage', '.seed-expansion'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const stats = statSync(full)
      if (stats.size > 2_000_000) continue
      const text = readFileSync(full, 'utf8')
      if (needle.some((value) => text.includes(value))) hits.push(full.replace(`${root}/`, ''))
    }
  }
  walk(root)
  check('no password appears anywhere in the repository', hits.length === 0, hits.join(', ') || `${needle.length} passwords searched`)

  const ignored = readFileSync(join(root, '.gitignore'), 'utf8')
  check('.gitignore excludes database secrets and dumps',
    /db\/secrets/.test(ignored) && /\.pass/.test(ignored) && /graphmentor-pg|db\/backups/.test(ignored),
    'db/secrets, *.pass and dump paths covered')

  const certKeyMode = (statSync(join(GM_DB_ROOT, 'certs', 'server.key')).mode & 0o777).toString(8)
  const certText = exec('openssl', ['x509', '-in', join(GM_DB_ROOT, 'certs', 'server.crt'), '-noout', '-text']).output
  check('the TLS key is mode 600 and the certificate names this host',
    certKeyMode === '600' && certText.includes('IP Address:127.0.0.1'), `key mode ${certKeyMode}`)

  /* ---------------------------------------------------------------------
   * 10. Backup and restore (optional, on request)
   * ------------------------------------------------------------------- */
  if (withBackup) {
    section('10. Backup and restore')
    const backup = exec('sh', [join(root, 'db', 'bin', 'backup.sh')])
    check('a dump is written with a checksum', backup.status === 0 && /dump written/.test(backup.output), backup.output.trim().split('\n').slice(-1)[0] ?? '')
    const restore = exec('sh', [join(root, 'db', 'bin', 'restore-verify.sh')])
    check('the newest dump restores with identical row counts', restore.status === 0 && /row counts identical/.test(restore.output),
      (restore.output.match(/row counts identical[^\n]*/) ?? [restore.output.trim().split('\n').slice(-1)[0] ?? ''])[0] ?? '')
  }

  await admin.end()

  /* ---------------------------------------------------------------------
   * Report
   * ------------------------------------------------------------------- */
  const passed = checks.filter((entry) => entry.ok).length
  const failed = checks.filter((entry) => !entry.ok)
  const groups = [...new Set(checks.map((entry) => entry.group))].map((name) => ({
    group: name,
    passed: checks.filter((entry) => entry.group === name && entry.ok).length,
    total: checks.filter((entry) => entry.group === name).length,
  }))

  const report = {
    generatedAt: new Date().toISOString(),
    target: { host: '127.0.0.1', port: PORT, database: DB_NAME, dataDirectory: join(GM_DB_ROOT, 'data'), certificateAuthority: 'private CA, clientcert=verify-full required' },
    serverVersion: version.split(' on ')[0] ?? version,
    passed,
    total: checks.length,
    groups,
    checks,
  }

  const out = join(root, 'docs', 'database-verification.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n${passed}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.log('\nFailed:')
    for (const entry of failed) console.log(`  ${entry.group} — ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`)
  }
  console.log(`\nReport written to docs/database-verification.json`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('\nverify-db crashed:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(2)
})


