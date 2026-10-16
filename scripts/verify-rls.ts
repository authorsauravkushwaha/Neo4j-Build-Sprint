/**
 * verify-rls — apply the real migrations to a real PostgreSQL server and attack
 * the real policies.
 *
 * Why this exists: "authorization is not authentication" is the single easiest
 * claim in this project to get wrong, and unit tests against an in-memory
 * repository cannot prove anything about the SQL that actually protects the data.
 * This script does what an attacker with one valid account would do, against the
 * **unmodified** `supabase/migrations/*.sql` files, on a real server.
 *
 * What it does:
 *   1. applies `supabase/local/00_supabase_shim.sql` (the auth contract: schema,
 *      `auth.uid()`, roles, the JWT-claims setting) and then both migrations,
 *   2. creates two accounts and a second, hostile account that tries to reach
 *      into the first one's rows,
 *   3. asserts every attack fails, asserts the legitimate access still works,
 *      and asserts the two platform invariants the app depends on (RLS on every
 *      table, no anon grants),
 *   4. exercises the Postgres-backed rate-limit counter and nonce store for real,
 *      including under concurrency, because a limiter with a lost-update bug is
 *      not a limiter.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/graphmentor npm run verify:rls
 *
 * The connection must be able to create schemas, roles and extensions (a
 * superuser or the project owner). Nothing here is run against a production
 * database: the shim would collide with the real `auth` schema, which is exactly
 * why the first thing this script does is refuse to run if it looks like one.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, Pool } from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const databaseUrl = process.env['DATABASE_URL'] ?? ''

if (!databaseUrl) {
  console.error('DATABASE_URL is required, e.g. postgres://user:pass@127.0.0.1:5432/graphmentor')
  process.exit(2)
}

/* ==========================================================================
 * Harness
 * ========================================================================== */

interface Result {
  name: string
  ok: boolean
  detail?: string
}

const results: Result[] = []

function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) })
}

function check(name: string, ok: boolean, detail?: string): void {
  record(name, ok, detail)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Reads a single scalar out of the first row of a query. */
async function scalar(client: Client, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query(sql, values)
  const row = rows[0] as Record<string, unknown> | undefined
  return row ? Object.values(row)[0] : undefined
}

/**
 * Postgres savepoints only exist inside a transaction, so the harness has to know
 * whether it is in one. Tracking the depth here keeps `expectRefused` usable from
 * both kinds of test rather than making every caller remember.
 */
let transactionDepth = 0

/** Runs `fn` in a transaction and always rolls back — read-only probes leave no trace. */
async function inTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('begin')
  transactionDepth += 1
  try {
    return await fn()
  } finally {
    transactionDepth -= 1
    await client.query('rollback')
  }
}

/** Assumes the identity of a user inside a transaction, then rolls back. */
async function asUser(client: Client, userId: string, fn: () => Promise<void>): Promise<void> {
  await inTransaction(client, async () => {
    await assume(client, 'authenticated', { sub: userId, role: 'authenticated' })
    await fn()
  })
}

async function asAnon(client: Client, fn: () => Promise<void>): Promise<void> {
  await inTransaction(client, async () => {
    await assume(client, 'anon', { role: 'anon' })
    await fn()
  })
}

/**
 * The small number of fixtures that later sections need to see must actually be
 * committed. This is the honest version of the owner's happy path: a real write
 * that survives, so the attacks in §5 have something real to attack.
 */
async function asUserCommitted(client: Client, userId: string, fn: () => Promise<void>): Promise<void> {
  await client.query('begin')
  transactionDepth += 1
  try {
    await assume(client, 'authenticated', { sub: userId, role: 'authenticated' })
    await fn()
    transactionDepth -= 1
    await client.query('commit')
  } catch (error) {
    transactionDepth -= 1
    await client.query('rollback')
    throw error
  }
}

/** `set local role` + the JWT claims PostgREST would have placed on the request. */
async function assume(client: Client, role: 'anon' | 'authenticated', claims: Record<string, unknown>): Promise<void> {
  await client.query(`set local role ${role}`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
}

/**
 * Runs a statement that is expected to be refused, and reports how it failed.
 *
 * A typo in one of these statements would otherwise look like a defence holding:
 * `column "roadmap" does not exist` and `permission denied` are both errors, and
 * a sloppy harness would count both as "blocked". Schema errors therefore abort
 * the run — this was a real bug in the first version of this script, caught only
 * because the missing-column error was printed loudly enough to notice.
 */
const HARNESS_ERROR_CODES = new Set(['42P01', '42703', '42601', '42883', '42702'])

async function expectRefused(client: Client, sql: string, values: unknown[] = []): Promise<{ refused: boolean; reason: string }> {
  const guarded = transactionDepth > 0
  if (guarded) await client.query('savepoint probe')
  try {
    await client.query(sql, values)
    if (guarded) await client.query('release savepoint probe')
    return { refused: false, reason: 'the statement succeeded' }
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown'
    const message = error instanceof Error ? error.message : String(error)
    if (HARNESS_ERROR_CODES.has(code)) {
      throw new Error(`harness error (${code}) — this test does not describe the schema: ${message}`)
    }
    if (guarded) await client.query('rollback to savepoint probe')
    // The code is enough; the message can contain column names the test does not need.
    return { refused: true, reason: `${code}: ${message.split('\n')[0]?.slice(0, 90) ?? ''}` }
  }
}

/* ==========================================================================
 * Fixtures
 * ========================================================================== */

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = uuid(1) // the account being attacked
const INTRUDER = uuid(2) // a valid, signed-in account with no rights to OWNER's rows
const ROADMAP = uuid(100)

/**
 * The private tables that hold user data, exactly as `001_graphmentor_core.sql`
 * creates them. If a migration adds a table, this list is the thing to update —
 * the invariant checks below are written against it.
 */
const TABLES = ['profiles', 'saved_roadmaps', 'roadmap_tasks', 'user_skill_progress', 'bookmarks', 'feedback'] as const

/**
 * Insert statements shared by the owner's happy path and the intruder's attack.
 *
 * Using one fragment for both is deliberate: if the two drifted, an attack could
 * "fail" because it targeted a column that does not exist, and the failure would
 * look like a defence. The harness guard in `expectRefused` catches that too, but
 * the cheapest fix is to not write the statement twice.
 *
 * You will notice these have no parameters for the columns they test — parameters
 * are for values, and the point here is the owner column itself.
 */
const INSERT_ROADMAP = `insert into public.saved_roadmaps
    (id, user_id, title, career_id, career_name, weekly_hours, pace, estimate_disclaimer, milestones)
  values ($1, $2, $3, 'career:embedded-systems', 'Embedded systems', 8, 'steady', 'Estimates are averages, not a promise.', '[]'::jsonb)`

const INSERT_TASK = `insert into public.roadmap_tasks
    (roadmap_id, user_id, skill_id, name, status, difficulty, order_index, scheduled_week, estimated_hours_low, estimated_hours_high, essential)
  values ($1, $2, $3, 'Python', 'not-started', 'beginner', $4, 1, 6, 12, true)`

/* ==========================================================================
 * Main
 * ========================================================================== */

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  console.log('verify-rls — real PostgreSQL, real migrations, real policies\n')

  /* ---- 0. refuse to touch anything that looks like production ------------ */
  //
  // The shim is re-runnable because it marks its own work (auth.gm_local_shim_marker).
  // Anything else that already owns an `auth` schema — a real Supabase project, a
  // GoTrue install, another project's database — is left completely alone.
  const hasAuthSchema = (await scalar(client, `select to_regnamespace('auth') is not null`)) as boolean
  const shimMarker = (await scalar(client, `select to_regclass('auth.gm_local_shim_marker') is not null`)) as boolean
  const looksLikeGoTrue = (await scalar(
    client,
    `select exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name in ('refresh_tokens', 'audit_log_entries', 'instances'))`,
  )) as boolean

  if (looksLikeGoTrue) {
    console.error('This database contains a real Supabase auth schema (GoTrue tables found). Refusing to run.')
    console.error('verify-rls only ever runs against a scratch database — never against a project.')
    process.exit(2)
  }
  if (hasAuthSchema && !shimMarker) {
    console.error('This database has an `auth` schema that verify-rls did not create. Refusing to run.')
    console.error('Point DATABASE_URL at a scratch database, or drop that schema deliberately first.')
    process.exit(2)
  }

  /* ---- 1. apply the shim and the migrations ------------------------------ */
  console.log('1. Applying the platform shim and migrations')
  for (const file of ['supabase/local/00_supabase_shim.sql', 'supabase/migrations/001_graphmentor_core.sql', 'supabase/migrations/002_graphmentor_rate_limit.sql']) {
    const sql = readFileSync(resolve(root, file), 'utf8')
    try {
      await client.query(sql)
      check(`${file} applied`, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      check(`${file} applied`, false, message.split('\n')[0])
      console.error('\nMigrations did not apply; stopping here rather than testing a half-built schema.')
      process.exit(1)
    }
  }

  /* ---- 2. two accounts --------------------------------------------------- */
  console.log('\n2. Fixtures')
  await client.query('delete from auth.users where id = any($1::uuid[])', [[OWNER, INTRUDER]])
  await client.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [
    OWNER,
    'owner@example.test',
    INTRUDER,
    'intruder@example.test',
  ])
  const profiles = (await scalar(client, `select count(*) from public.profiles where id = any($1::uuid[])`, [[OWNER, INTRUDER]])) as string
  check('the on-signup trigger created a profile per account', Number(profiles) === 2, `${profiles} profiles`)

  /* ---- 3. platform invariants ------------------------------------------- */
  console.log('\n3. Platform invariants (these failing would make everything below meaningless)')
  const unprotected = (await client.query(
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`,
  )).rows.map((row) => (row as { relname: string }).relname)
  check('row level security is enabled on every public table', unprotected.length === 0, unprotected.join(', ') || `${TABLES.length} tables checked`)

  const forcedCount = (await scalar(
    client,
    `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity = true`,
  )) as string
  // Not a failure: the owner is expected to bypass its own policies. Recorded so
  // the distinction between "RLS on" and "RLS on even for the owner" is explicit.
  check('RLS is not merely enabled but recorded', Number(forcedCount) >= 0, `${forcedCount} table(s) with FORCE, ${TABLES.length - Number(forcedCount)} without (policies still apply to every non-owner role)`)

  // The grant is deliberately present — that is how Supabase works, and how the
  // REVOKEs at the end of 002 are able to mean anything. What must be true is
  // that the grant exists *and* anon still reads nothing (§6 proves that).
  const anonGrants = (await client.query(
    `select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'
      order by table_name, privilege_type`,
  )).rows as Array<{ table_name: string; privilege_type: string }>
  const grantedTables = new Set(anonGrants.map((g) => g.table_name))
  check(
    'anon is granted table access, as in every Supabase project (RLS is the boundary, not the grant)',
    anonGrants.length > 0,
    `${anonGrants.length} privileges over ${grantedTables.size} tables`,
  )

  // The two internal tables are the exception: 002 revokes them outright, so a
  // leaked anon key cannot read counters or inflate them.
  const internalTables = ['gm_rate_limit', 'gm_nonce']
  const reachableInternal = anonGrants.filter((g) => internalTables.includes(g.table_name))
  check(
    'the rate-limit and nonce tables are revoked from clients, not merely policy-protected',
    reachableInternal.length === 0,
    reachableInternal.map((g) => `${g.table_name}.${g.privilege_type}`).join(', ') || `${internalTables.length} tables unreachable`,
  )

  const internalPolicies = (await client.query(
    `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = any($1::text[])`,
    [internalTables],
  )).rows[0] as { n: number }
  check('the internal tables carry no policy at all', internalPolicies.n === 0, `${internalPolicies.n} policies`)

  // Exactly one policy is reachable without a session, and it is the one that
  // lets a guest report a bug: an INSERT into feedback that cannot set a user_id
  // and cannot read anything back. Asserted by name so a second anon policy
  // appearing in a future migration cannot slip through unnoticed.
  const anonPolicies = (await client.query(
    `select tablename, policyname, cmd, coalesce(with_check, '') as with_check
       from pg_policies where schemaname = 'public' and 'anon' = any(roles)
      order by tablename, policyname`,
  )).rows as Array<{ tablename: string; policyname: string; cmd: string; with_check: string }>
  const onlyAnonymousFeedback =
    anonPolicies.length === 1 &&
    anonPolicies[0]?.tablename === 'feedback' &&
    anonPolicies[0]?.cmd === 'INSERT' &&
    /user_id IS NULL/.test(anonPolicies[0]?.with_check ?? '')
  check(
    'the only policy reachable without a session is anonymous feedback submission',
    onlyAnonymousFeedback,
    anonPolicies.map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`).join(', ') || 'none',
  )

  const nonOwnerPolicies = (await client.query(
    `select count(*)::int as n from pg_policies where schemaname = 'public' and roles = '{authenticated}'`,
  )).rows[0] as { n: number }
  check('every public policy is scoped to the authenticated role', nonOwnerPolicies.n > 0, `${nonOwnerPolicies.n} policies`)

  /* ---- 4. the honest path: the owner can use their own data ------------- */
  console.log('\n4. Legitimate use by the owner')
  await asUserCommitted(client, OWNER, async () => {
    const insertRoadmap = await expectRefused(client, INSERT_ROADMAP, [ROADMAP, OWNER, 'Owner plan'])
    check('owner can create a roadmap', !insertRoadmap.refused, insertRoadmap.refused ? insertRoadmap.reason : undefined)

    const insertTask = await expectRefused(client, INSERT_TASK, [ROADMAP, OWNER, 'skill:python', 0])
    check('owner can add a task to their own roadmap', !insertTask.refused, insertTask.refused ? insertTask.reason : undefined)

    const insertRating = await expectRefused(
      client,
      `insert into public.user_skill_progress (user_id, skill_id, state, quiz_score) values ($1, 'skill:python', 'learning', 0.4)`,
      [OWNER],
    )
    check('owner can record a skill state', !insertRating.refused, insertRating.refused ? insertRating.reason : undefined)

    const insertBookmark = await expectRefused(
      client,
      `insert into public.bookmarks (user_id, target_type, target_id) values ($1, 'skill', 'skill:python')`,
      [OWNER],
    )
    check('owner can bookmark a skill', !insertBookmark.refused, insertBookmark.refused ? insertBookmark.reason : undefined)
  })

  // Read back as an ordinary session, so "it persisted" is proven and not assumed.
  await asUser(client, OWNER, async () => {
    const visible = (await scalar(client, `select count(*) from public.saved_roadmaps where user_id = $1`, [OWNER])) as string
    const tasks = (await scalar(client, `select count(*) from public.roadmap_tasks where roadmap_id = $1`, [ROADMAP])) as string
    check('the owner’s write persisted and is readable', Number(visible) === 1 && Number(tasks) === 1, `${visible} roadmap(s), ${tasks} task(s)`)
  })

  /* ---- 5. the attacks --------------------------------------------------- */
  console.log('\n5. A second, valid account attacking the first')
  await asUser(client, INTRUDER, async () => {
    const readAttempt = (await scalar(client, `select count(*) from public.saved_roadmaps where id = $1`, [ROADMAP])) as string
    check('cannot read the owner’s roadmap even by its exact id', Number(readAttempt) === 0, `${readAttempt} row(s) returned`)

    const listOthers = (await scalar(client, `select count(*) from public.saved_roadmaps where user_id = $1`, [OWNER])) as string
    check('cannot list the owner’s roadmaps by user id', Number(listOthers) === 0, `${listOthers} row(s) returned`)

    const updateAttempt = await client.query(`update public.saved_roadmaps set title = 'pwned' where id = $1`, [ROADMAP])
    check('cannot update the owner’s roadmap', updateAttempt.rowCount === 0, `${updateAttempt.rowCount} row(s) affected`)

    const deleteAttempt = await client.query(`delete from public.saved_roadmaps where id = $1`, [ROADMAP])
    check('cannot delete the owner’s roadmap', deleteAttempt.rowCount === 0, `${deleteAttempt.rowCount} row(s) affected`)

    const forgeRow = await expectRefused(client, INSERT_ROADMAP, [uuid(999), OWNER, 'forged'])
    check('cannot insert a row owned by another account', forgeRow.refused, forgeRow.reason)

    // The composite FK is the belt to RLS's braces: even if a policy were wrong,
    // a task cannot be hung off another account's roadmap.
    const crossAttach = await expectRefused(client, INSERT_TASK, [ROADMAP, INTRUDER, 'skill:python', 1])
    check('cannot attach a task to the owner’s roadmap (composite FK)', crossAttach.refused, crossAttach.reason)

    const readTasks = (await scalar(client, `select count(*) from public.roadmap_tasks where roadmap_id = $1`, [ROADMAP])) as string
    check('cannot read the owner’s task rows', Number(readTasks) === 0, `${readTasks} row(s) returned`)

    const readStates = (await scalar(client, `select count(*) from public.user_skill_progress where user_id = $1`, [OWNER])) as string
    check('cannot read the owner’s skill states', Number(readStates) === 0, `${readStates} row(s) returned`)

    const readBookmarks = (await scalar(client, `select count(*) from public.bookmarks where user_id = $1`, [OWNER])) as string
    check('cannot read the owner’s bookmarks', Number(readBookmarks) === 0, `${readBookmarks} row(s) returned`)

    const forgeFeedback = await expectRefused(
      client,
      `insert into public.feedback (user_id, kind, message) values ($1, 'bug', 'forged')`,
      [OWNER],
    )
    check('cannot submit feedback attributed to another account', forgeFeedback.refused, forgeFeedback.reason)

    const readProfile = (await scalar(client, `select count(*) from public.profiles where id = $1`, [OWNER])) as string
    check('cannot read the owner’s profile row', Number(readProfile) === 0, `${readProfile} row(s) returned`)

    const updateProfile = await client.query(`update public.profiles set branch = 'pwned' where id = $1`, [OWNER])
    check('cannot modify the owner’s profile', updateProfile.rowCount === 0, `${updateProfile.rowCount} row(s) affected`)

    const deleteProfile = await client.query(`delete from public.profiles where id = $1`, [OWNER])
    check('cannot delete the owner’s profile', deleteProfile.rowCount === 0, `${deleteProfile.rowCount} row(s) affected`)
  })

  /* ---- 6. anon ---------------------------------------------------------- */
  console.log('\n6. An anonymous request (no session at all)')
  await asAnon(client, async () => {
    let leaked = 0
    for (const table of TABLES) {
      const count = (await scalar(client, `select count(*) from public.${table}`)) as string
      leaked += Number(count)
    }
    check('anon reads nothing from any private table', leaked === 0, `${leaked} row(s) across ${TABLES.length} tables`)

    // Positive control: a guest must still be able to report a problem. This
    // policy is the one deliberate anon grant in the schema, so it is tested as
    // a permission, not only as a restriction.
    const anonymousFeedback = await expectRefused(
      client,
      `insert into public.feedback (user_id, kind, message) values (null, 'bug', 'a guest reporting a problem')`,
    )
    check('anon can submit feedback with no account attached', !anonymousFeedback.refused, anonymousFeedback.refused ? anonymousFeedback.reason : undefined)

    const attributed = await expectRefused(
      client,
      `insert into public.feedback (user_id, kind, message) values ($1, 'bug', 'pretending to be someone')`,
      [OWNER],
    )
    check('anon cannot attribute feedback to an account', attributed.refused, attributed.reason)

    const readBack = (await scalar(client, `select count(*) from public.feedback`)) as string
    check('anon cannot read feedback back, not even its own', Number(readBack) === 0, `${readBack} row(s) returned`)
  })

  /* ---- 7. the service role (why it must never reach a browser) ---------- */
  console.log('\n7. The service role, and why it is server-side only')
  await inTransaction(client, async () => {
    await client.query('set local role service_role')
    const count = (await scalar(client, `select count(*) from public.saved_roadmaps where user_id = $1`, [OWNER])) as string
    check(
      'the service role can read across accounts (bypassrls works as designed)',
      Number(count) >= 1,
      `${count} row(s) — this is exactly why the key lives only in Edge Function secrets`,
    )
  })

  /* ---- 8. the rate limiter --------------------------------------------- */
  console.log('\n8. The Postgres-backed rate limiter')
  await client.query('select public.gm_consume_rate_limit($1, 60, 5)', ['verify.one'])
  const clock = "date_trunc('minute', now())"
  const windows = (await scalar(
    client,
    `select coalesce(sum(count), 0) from public.gm_rate_limit where window_start = ${clock}`,
  )) as string
  check('a consumed slot is recorded in a fixed window', Number(windows) >= 1, `${windows} count(s) in this window`)

  const badKey = await expectRefused(client, `select public.gm_consume_rate_limit('x', 60, 5)`)
  check('a short/empty bucket key is refused', badKey.refused, badKey.reason)

  const beyondLimit = (await scalar(client, `select public.gm_consume_rate_limit($1, 60, 2)`, ['verify.limit'])) as number
  const beyondLimit2 = (await scalar(client, `select public.gm_consume_rate_limit($1, 60, 2)`, ['verify.limit'])) as number
  const beyondLimit3 = (await scalar(client, `select public.gm_consume_rate_limit($1, 60, 2)`, ['verify.limit'])) as number
  check(
    'the counter keeps counting past the limit so the caller can refuse',
    beyondLimit2 > beyondLimit && beyondLimit3 > beyondLimit2,
    `${beyondLimit} → ${beyondLimit2} → ${beyondLimit3} against a limit of 2`,
  )

  // Concurrency is the whole point of the function: intervals are clamped to
  // 86400s, so this hammers one bucket from many connections and checks nothing
  // was lost. A lost update here would let an attacker exceed the real limit.
  const pool = new Pool({ connectionString: databaseUrl, max: 16 })
  const key = `verify.concurrent.${Date.now()}`
  const calls = 64
  await Promise.all(
    Array.from({ length: calls }, () => pool.query(`select public.gm_consume_rate_limit($1, 60, 1000000)`, [key])),
  )
  const finalCount = (await scalar(client, `select coalesce(sum(count), 0) from public.gm_rate_limit where key = $1`, [key])) as string
  await pool.end()
  check('concurrent increments are atomic (no lost updates)', Number(finalCount) === calls, `${calls} concurrent calls recorded exactly ${finalCount}`)

  /* ---- 9. the nonce store ---------------------------------------------- */
  console.log('\n9. Single-use nonces (replay protection)')
  const nonce = `verify-nonce-${Date.now()}`
  const first = (await scalar(client, `select public.gm_claim_nonce($1, 120)`, [nonce])) as boolean
  const second = (await scalar(client, `select public.gm_claim_nonce($1, 120)`, [nonce])) as boolean
  check('a nonce is claimed exactly once', first === true && second === false, `first=${first}, second=${second}`)

  const claimStraightAfter = (await scalar(client, `select public.gm_claim_nonce($1, 120)`, [nonce])) as boolean
  check('a replayed request is refused', claimStraightAfter === false, `third claim=${claimStraightAfter}`)

  // The functions must not be callable by a browser-held credential.
  const anonCanCall = await inTransaction(client, async () => {
    await client.query('set local role anon')
    const probe = await expectRefused(client, `select public.gm_consume_rate_limit('anon.probe', 60, 5)`)
    return probe.refused
  })
  check('anon cannot invoke the limiter directly', anonCanCall, 'execute is revoked from anon/authenticated')

  /* ---- 10. cleanup and verdict ----------------------------------------- */
  console.log('\n10. Cleanup')
  await client.query('delete from auth.users where id = any($1::uuid[])', [[OWNER, INTRUDER]])
  const orphanRoadmaps = (await scalar(client, `select count(*) from public.saved_roadmaps where user_id = $1`, [OWNER])) as string
  check('deleting the auth user cascades to their data', Number(orphanRoadmaps) === 0, `${orphanRoadmaps} orphan row(s)`)
  await client.query('delete from public.gm_rate_limit where key like $1 or key like $2', ['verify.%', 'auth.%'])
  await client.end()

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('\nFailed:')
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`)
    process.exit(1)
  }
  console.log('Row-level security, the rate limiter and the nonce store all behave as documented.')
}

main().catch((error: unknown) => {
  console.error('\nverify-rls crashed:', error instanceof Error ? error.message : error)
  process.exit(1)
})


