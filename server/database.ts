/** Server-only storage. Embedded Postgres is disk-backed, never browser storage. */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_stat_statements } from '@electric-sql/pglite/contrib/pg_stat_statements'
import lockfile from 'proper-lockfile'
import { Pool } from 'pg'

export interface DatabaseClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}
export interface Database {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  connect(): Promise<DatabaseClient>
  end(): Promise<void>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Apply the SAME identity/schema/RLS files as the full PostgreSQL deployment. */
async function migrate(db: PGlite): Promise<void> {
  await db.exec('create schema if not exists gm_internal; create table if not exists gm_internal.migrations (version integer primary key)')
  const applied = await db.query('select version from gm_internal.migrations where version = 1')
  if (applied.rows.length) return
  await db.transaction(async (tx) => {
    // No network logins exist in the embedded engine. Runtime uses gm_auth,
    // not the bootstrap superuser, and retains the existing least-privilege grants.
    await tx.exec(`
      create role gm_admin nologin;
      create role gm_owner nologin noinherit;
      create role gm_app nologin noinherit;
      create role gm_auth nologin noinherit;
      create role anon nologin noinherit;
      create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls;
      grant create on schema public to gm_owner;
      grant create on database postgres to gm_owner;
      set role gm_owner;
    `)
    for (const file of [
      'db/identity/00_auth_contract.sql',
      'db/identity/01_credentials.sql',
      'supabase/migrations/001_graphmentor_core.sql',
      'supabase/migrations/002_graphmentor_rate_limit.sql',
      'db/identity/02_task_progress.sql',
    ]) {
      await tx.exec(readFileSync(join(root, file), 'utf8'))
    }
    await tx.exec('reset role')
    // PGlite names its database postgres; no other schema SQL is changed.
    await tx.exec(readFileSync(join(root, 'db/security/00_hardening.sql'), 'utf8')
      .replaceAll('on database graphmentor', 'on database postgres'))
    await tx.exec('insert into gm_internal.migrations values (1)')
  })
}

export async function openEmbeddedDatabase(directory: string): Promise<Database> {
  const path = resolve(directory)
  await mkdir(path, { recursive: true, mode: 0o700 })
  // A single embedded instance owns a data directory. Refuse a second process
  // instead of risking corruption; stale locks from crashes are recoverable.
  const unlock = await lockfile.lock(path, { stale: 10_000, retries: 0 })
  let db: PGlite | undefined
  try {
    db = await PGlite.create(path, { extensions: { pgcrypto, pg_stat_statements } })
    await migrate(db)
    await db.exec('set role gm_auth')
  } catch (error) {
    await db?.close()
    await unlock()
    throw error
  }
  const engine = db
  // PGlite is a single connection. A leased client must own it through COMMIT
  // or ROLLBACK, so another request cannot accidentally enter its transaction.
  let tail = Promise.resolve()
  let closed = false
  let ending: Promise<void> | undefined
  async function acquire(): Promise<() => void> {
    if (closed) throw new Error('Database is closed')
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((done) => { release = done })
    await previous
    return release
  }
  const query = async (sql: string, values?: unknown[]) => engine.query<Record<string, unknown>>(sql, values)
  return {
    async query(sql, values) {
      const release = await acquire()
      try { return await query(sql, values) } finally { release() }
    },
    async connect() {
      const release = await acquire()
      let released = false
      return {
        query(sql, values) {
          if (released) throw new Error('Client already released')
          return query(sql, values)
        },
        release() { if (!released) { released = true; release() } },
      }
    },
    end() {
      if (ending) return ending
      closed = true
      ending = (async () => {
        await tail
        try { await engine.close() } finally { await unlock() }
      })()
      return ending
    },
  }
}

export async function openDatabase(env: NodeJS.ProcessEnv = process.env): Promise<Database> {
  if (env['DATABASE_AUTH_URL']) {
    const pool = new Pool({ connectionString: env['DATABASE_AUTH_URL'], max: 4, connectionTimeoutMillis: 5000 })
    try { await pool.query('select 1') } catch (error) { await pool.end(); throw error }
    return pool
  }
  const pgRoot = env['GM_DB_ROOT'] ?? '/srv/graphmentor-pg'
  if (existsSync(join(pgRoot, 'secrets/gm_auth.pass'))) {
    const pool = new Pool({
      host: '127.0.0.1', port: Number(env['GM_PORT'] ?? 5433),
      database: env['GM_DB_NAME'] ?? 'graphmentor', user: 'gm_auth',
      password: readFileSync(join(pgRoot, 'secrets/gm_auth.pass'), 'utf8').trim(),
      ssl: {
        ca: readFileSync(join(pgRoot, 'certs/ca.crt')),
        cert: readFileSync(join(pgRoot, 'certs/client-gm_auth.crt')),
        key: readFileSync(join(pgRoot, 'certs/client-gm_auth.key')), rejectUnauthorized: true,
      },
      max: 4, connectionTimeoutMillis: 5000,
    })
    try { await pool.query('select 1') } catch (error) { await pool.end(); throw error }
    return pool
  }
  if (env['GM_DB_ROOT']) throw new Error('GM_DB_ROOT is configured but not provisioned. Run npm run db:provision.')
  return openEmbeddedDatabase(env['GM_DATABASE_DIR'] ?? join(root, '.localdata/postgres'))
}
