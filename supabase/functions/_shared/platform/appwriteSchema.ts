/**
 * The Appwrite side of the storage schema.
 *
 * `appwrite.ts` implements the same client seam as `supabaseStore.ts`, and
 * `scripts/appwrite-schema.ts` provisions collections from this file. Both read
 * *this* module, so a table can never be written by the adapter without a
 * collection to write it into, and an index can never exist for an upsert that
 * the code does not perform. A test in `tests/unit/appwrite-schema.test.ts`
 * enforces that pairing against the source of `supabaseStore.ts`.
 *
 * Why the schema lives in TypeScript rather than in Appwrite's console:
 *   - the conflict targets that make `upsert` idempotent are exactly the unique
 *     indexes below; if they drift, a re-save silently duplicates a roadmap;
 *   - on Postgres, Row Level Security is the security boundary. Appwrite has no
 *     equivalent that a server-side API key is subject to, so the boundary has
 *     to be declared somewhere a reviewer can read — `scope` and `permissions`
 *     below are that declaration, and `appwrite.ts` enforces `scope` in code.
 */
export type AppwriteAttributeType = 'string' | 'integer' | 'double' | 'boolean' | 'datetime'

export interface AppwriteAttribute {
  key: string
  type: AppwriteAttributeType
  /** Appwrite requires a maximum length for strings; ignored for other types. */
  size?: number
  required: boolean
  /** Columns whose values the adapter serialises to text (Appwrite has no json/array type). */
  jsonText?: boolean
}

export interface AppwriteIndex {
  key: string
  type: 'unique' | 'key'
  attributes: string[]
  orders?: Array<'ASC' | 'DESC'>
}

/**
 * `user`   — rows carry `user_id`; every read/write must be scoped by it.
 * `self`   — the primary key *is* the user id (`profiles`).
 * `server` — infrastructure rows (rate-limit hits, nonces) that no user reads.
 */
export type AppwriteScope = 'user' | 'self' | 'server'

export interface AppwriteCollection {
  id: string
  name: string
  scope: AppwriteScope
  attributes: AppwriteAttribute[]
  indexes: AppwriteIndex[]
}

/** Appwrite project database. One database, many collections — as Postgres has one schema, many tables. */
export const APPWRITE_DATABASE_ID = 'graphmentor'

/**
 * Every collection is **server-only**: no role is granted read or write, so the
 * document API is reachable only with the project API key that the Edge
 * Functions hold. On Supabase this job is done by RLS policies; here it is done
 * by having no permissions at all. The client never talks to Appwrite directly —
 * it talks to our API, which is the only holder of the key.
 */
export const SERVER_ONLY_PERMISSIONS = { read: [] as string[], write: [] as string[] }

const uuid = (key: string, required = true): AppwriteAttribute => ({ key, type: 'string', size: 36, required })
const text = (key: string, size: number, required = false): AppwriteAttribute => ({ key, type: 'string', size, required })
const number = (key: string, required = false): AppwriteAttribute => ({ key, type: 'double', required })
const whole = (key: string, required = false): AppwriteAttribute => ({ key, type: 'integer', required })
const flag = (key: string, required = false): AppwriteAttribute => ({ key, type: 'boolean', required })
const when = (key: string, required = true): AppwriteAttribute => ({ key, type: 'datetime', required })

const created = (): AppwriteAttribute[] => [when('created_at'), when('updated_at')]

export const APPWRITE_COLLECTIONS: readonly AppwriteCollection[] = [
  {
    id: 'profiles',
    name: 'Profiles',
    scope: 'self',
    attributes: [
      uuid('id'),
      text('education_level', 200),
      text('branch', 200),
      text('career_goal_id', 72),
      // text[] in Postgres; JSON text here (see JSON_TEXT_COLUMNS below).
      { key: 'interests', type: 'string', size: 2000, required: false, jsonText: true },
      whole('weekly_hours'),
      text('preferred_pace', 16),
      text('learning_style', 16),
      text('goal_note', 200),
      text('theme', 16),
      flag('reduced_motion'),
      ...created(),
    ],
    indexes: [{ key: 'profiles_id_unique', type: 'unique', attributes: ['id'] }],
  },
  {
    id: 'saved_roadmaps',
    name: 'Saved roadmaps',
    scope: 'user',
    attributes: [
      uuid('id'),
      uuid('user_id'),
      text('title', 120, true),
      text('career_id', 72, true),
      text('career_name', 160, true),
      whole('weekly_hours', true),
      text('pace', 16, true),
      text('estimate_disclaimer', 600, true),
      // jsonb in Postgres; JSON text here.
      { key: 'milestones', type: 'string', size: 8000, required: false, jsonText: true },
      ...created(),
    ],
    indexes: [
      { key: 'saved_roadmaps_id_unique', type: 'unique', attributes: ['id'] },
      { key: 'saved_roadmaps_user_idx', type: 'key', attributes: ['user_id', 'updated_at'], orders: ['ASC', 'DESC'] },
    ],
  },
  {
    id: 'roadmap_tasks',
    name: 'Roadmap tasks',
    scope: 'user',
    attributes: [
      uuid('id'),
      uuid('roadmap_id', true),
      uuid('user_id'),
      text('skill_id', 72, true),
      text('name', 160, true),
      text('status', 16, true),
      text('difficulty', 16, true),
      whole('order_index', true),
      whole('scheduled_week', true),
      whole('scheduled_day'),
      number('estimated_hours_low', true),
      number('estimated_hours_high', true),
      flag('essential', true),
      text('note', 600),
      number('actual_hours'),
      ...created(),
    ],
    indexes: [
      { key: 'roadmap_tasks_id_unique', type: 'unique', attributes: ['id'] },
      // The conflict target of `upsert(..., { onConflict: 'roadmap_id,skill_id,order_index,status' })`.
      { key: 'roadmap_tasks_slot_unique', type: 'unique', attributes: ['roadmap_id', 'skill_id', 'order_index', 'status'] },
      { key: 'roadmap_tasks_user_idx', type: 'key', attributes: ['user_id', 'roadmap_id', 'order_index'] },
    ],
  },
  {
    id: 'user_skill_progress',
    name: 'Skill progress',
    scope: 'user',
    attributes: [
      uuid('id'),
      uuid('user_id'),
      text('skill_id', 72, true),
      text('state', 16, true),
      number('quiz_score'),
      ...created(),
    ],
    indexes: [
      { key: 'skill_progress_id_unique', type: 'unique', attributes: ['id'] },
      // The conflict target of `upsert(..., { onConflict: 'user_id,skill_id' })`.
      { key: 'skill_progress_skill_unique', type: 'unique', attributes: ['user_id', 'skill_id'] },
      { key: 'skill_progress_user_idx', type: 'key', attributes: ['user_id'] },
    ],
  },
  {
    id: 'bookmarks',
    name: 'Bookmarks',
    scope: 'user',
    attributes: [
      uuid('id'),
      uuid('user_id'),
      text('target_type', 16, true),
      text('target_id', 72, true),
      text('note', 400),
      ...created(),
    ],
    indexes: [
      { key: 'bookmarks_id_unique', type: 'unique', attributes: ['id'] },
      // The conflict target of `upsert(..., { onConflict: 'user_id,target_id' })`.
      { key: 'bookmarks_target_unique', type: 'unique', attributes: ['user_id', 'target_id'] },
      { key: 'bookmarks_user_idx', type: 'key', attributes: ['user_id', 'created_at'], orders: ['ASC', 'DESC'] },
    ],
  },
  {
    id: 'feedback',
    name: 'Feedback',
    scope: 'user',
    attributes: [
      uuid('id'),
      // Nullable on purpose: guests may submit feedback (see handlers/user.ts).
      uuid('user_id', false),
      text('kind', 16, true),
      text('message', 1500, true),
      text('contact', 160),
      text('target_id', 72),
      text('page_url', 300),
      when('created_at'),
    ],
    indexes: [
      { key: 'feedback_id_unique', type: 'unique', attributes: ['id'] },
      // The data export reads feedback by `user_id`, so the column needs an index
      // even though account deletion leaves the row (anonymised) in place.
      { key: 'feedback_user_idx', type: 'key', attributes: ['user_id'] },
      { key: 'feedback_created_idx', type: 'key', attributes: ['created_at'], orders: ['DESC'] },
    ],
  },
  {
    // One document per *request*, not one counter per window.
    id: 'rate_limit_hits',
    name: 'Rate limit hits',
    scope: 'server',
    attributes: [text('key', 200, true), whole('bucket', true), when('expires_at')],
    indexes: [
      { key: 'rate_limit_window_idx', type: 'key', attributes: ['key', 'bucket'] },
      { key: 'rate_limit_expiry_idx', type: 'key', attributes: ['expires_at'] },
    ],
  },
  {
    // The document id *is* the nonce hash: a primary-key insert is what makes a
    // replay impossible, exactly as it does in Postgres.
    id: 'used_nonces',
    name: 'Used nonces',
    scope: 'server',
    attributes: [text('nonce_hash', 64, true), when('expires_at')],
    indexes: [{ key: 'used_nonces_expiry_idx', type: 'key', attributes: ['expires_at'] }],
  },
]

/** Columns the adapter serialises as JSON text, because Appwrite has no json/array type. */
export const JSON_TEXT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  profiles: ['interests'],
  saved_roadmaps: ['milestones'],
}

/** Tables whose rows carry a `created_at` and should carry an `updated_at`. */
export const TIMESTAMPED_TABLES: readonly string[] = [
  'profiles',
  'saved_roadmaps',
  'roadmap_tasks',
  'user_skill_progress',
  'bookmarks',
  'feedback',
]

export function collectionFor(table: string): AppwriteCollection | null {
  return APPWRITE_COLLECTIONS.find((collection) => collection.id === table) ?? null
}

/**
 * The column that proves a query is scoped to one account, or `null` for
 * infrastructure tables. `appwrite.ts` refuses to build an unscoped query when
 * this returns a column — on Postgres a missing filter is caught by RLS, and
 * here it is caught before the request is sent.
 */
export function ownerColumnFor(table: string): string | null {
  const collection = collectionFor(table)
  if (!collection) return null
  if (collection.scope === 'user') return 'user_id'
  if (collection.scope === 'self') return 'id'
  return null
}

/* ==========================================================================
 * Provisioning
 * ========================================================================== */

export interface ProvisioningCommand {
  /** One `appwrite` CLI invocation, argv form, ready to print or spawn. */
  argv: string[]
  why: string
}

/**
 * Explicit CLI commands rather than a declarative file: `appwrite.json`'s
 * attribute shape differs between CLI majors, and a command list is checkable by
 * eye against the schema above. Run them in order — collections before indexes.
 */
/**
 * Appwrite's attribute types do not line up one-to-one with ours: `float` is the
 * closest thing to Postgres `numeric`, and there is no `json` or `text[]` type at
 * all (see `JSON_TEXT_COLUMNS`). Flags are printed in kebab-case, which is what
 * the current CLI accepts; older CLI majors spell them in camelCase.
 */
const ATTRIBUTE_COMMAND: Record<AppwriteAttributeType, string> = {
  string: 'create-string-attribute',
  integer: 'create-integer-attribute',
  double: 'create-float-attribute',
  boolean: 'create-boolean-attribute',
  datetime: 'create-datetime-attribute',
}

export function provisioningCommands(databaseId = APPWRITE_DATABASE_ID): ProvisioningCommand[] {
  const commands: ProvisioningCommand[] = [
    {
      argv: ['appwrite', 'databases', 'create', '--database-id', databaseId, '--name', 'GraphMentor AI'],
      why: 'One database for all collections; safe to skip if it exists.',
    },
  ]
  for (const collection of APPWRITE_COLLECTIONS) {
    commands.push({
      // No `--permissions` flag: the CLI's default is "no role may read or write",
      // which is exactly the boundary this collection needs.
      argv: ['appwrite', 'databases', 'create-collection', '--database-id', databaseId, '--collection-id', collection.id, '--name', collection.name],
      why: `No read/write permissions: only the server API key reaches ${collection.id} (${collection.scope} scope).`,
    })
    for (const attribute of collection.attributes) {
      const argv = [
        'appwrite',
        'databases',
        ATTRIBUTE_COMMAND[attribute.type],
        '--database-id',
        databaseId,
        '--collection-id',
        collection.id,
        '--key',
        attribute.key,
        '--required',
        String(attribute.required),
      ]
      if (attribute.size !== undefined) argv.push('--size', String(attribute.size))
      commands.push({ argv, why: `${collection.id}.${attribute.key}` })
    }
    for (const index of collection.indexes) {
      commands.push({
        argv: ['appwrite', 'databases', 'create-index', '--database-id', databaseId, '--collection-id', collection.id, '--key', index.key, '--type', index.type, '--attributes', ...index.attributes],
        why: index.type === 'unique' ? `Makes the upsert on ${index.attributes.join(', ')} idempotent.` : `Serves the queries that filter on ${index.attributes.join(', ')}.`,
      })
    }
  }
  return commands
}

/**
 * Every table name that appears in a `client.from('…')` call in supabaseStore.ts.
 * Used by the drift test; also a convenient way to answer "what does this app
 * actually store?" without reading the whole store.
 */
export function tablesUsedByStore(source: string): string[] {
  const tables = new Set<string>()
  for (const match of source.matchAll(/\.from\s*(?:<[^()]*>\s*)?\(\s*'([a-z_]+)'/g)) tables.add(match[1])
  return [...tables].sort()
}

/** Conflict targets (`onConflict: 'a,b'`) that `createUserRepositories` relies on. */
export function conflictTargetsUsedByStore(source: string): Array<{ table: string; columns: string[] }> {
  const out: Array<{ table: string; columns: string[] }> = []
  for (const match of source.matchAll(/\.from\s*(?:<[^()]*>\s*)?\(\s*'([a-z_]+)'\)([\s\S]{0,400}?)onConflict:\s*'([^']+)'/g)) {
    out.push({ table: match[1], columns: match[3].split(',').map((column) => column.trim()) })
  }
  return out
}
