/**
 * A recording fake of the Supabase/PostgREST client used by `supabaseStore.ts`.
 *
 * The in-memory repository helper mirrors the ownership rule, but it cannot show
 * *how* a query was built — and for "authentication is not authorisation" that is
 * exactly the question. This fake captures every chained call (table, operation,
 * values, filters, conflict target) so a test can assert that a write carried the
 * caller's id and never targeted a row belonging to somebody else.
 *
 * Responses are scripted in call order: `push({ data })` queues the next one.
 * Running out of responses yields `{ data: null, error: null }`, which is how a
 * real query matching nothing behaves.
 */
import type {
  AuthUser,
  PostgrestError,
  SupabaseLikeClient,
} from '../../supabase/functions/_shared/platform/supabaseStore.ts'

export type Operation = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

export interface RecordedQuery {
  table: string
  operation: Operation
  /** Payload for insert/update/upsert, exactly as the store passed it. */
  values?: unknown
  /** Conflict target for an upsert — the column(s) the write lands on. */
  onConflict?: string
  filters: Array<{ column: string; value: unknown; operator: 'eq' | 'in' | 'is' }>
  order?: { column: string; ascending?: boolean }
  limit?: number
  /** How the caller read the result back. */
  terminal?: 'single' | 'maybeSingle' | 'await'
}

export interface ScriptedResult {
  data?: unknown
  error?: PostgrestError | null
}

export interface FakePostgrest {
  /** Pass this to `createUserRepositories` / verifier / store factories. */
  client: SupabaseLikeClient
  /** Every query the store built, in order. */
  queries: RecordedQuery[]
  /** Queue the next response for a table query. */
  push(result: ScriptedResult): void
  /** Queue `count` responses that succeed with no rows. */
  pushEmpty(count: number): void
  /** Queries that touched a table, optionally narrowed by operation. */
  forTable(table: string, operation?: Operation): RecordedQuery[]
  /** Queue the answer `auth.getUser` will give, or an error. */
  pushAuth(result: { user?: AuthUser | null; error?: PostgrestError | null }): void
  /** Queue an `rpc` response by function name. */
  pushRpc(data: unknown, error?: PostgrestError | null): void
  /** Calls made through `rpc`, in order. */
  rpcCalls: Array<{ fn: string; args?: Record<string, unknown> }>
}

export function createFakePostgrest(): FakePostgrest {
  const queries: RecordedQuery[] = []
  const script: ScriptedResult[] = []
  const authScript: Array<{ user?: AuthUser | null; error?: PostgrestError | null }> = []
  const rpcScript: ScriptedResult[] = []
  const rpcCalls: Array<{ fn: string; args?: Record<string, unknown> }> = []

  const build = (table: string): unknown => {
    const query: RecordedQuery = { table, operation: 'select', filters: [] }
    let recorded = false

    const settle = async (terminal: RecordedQuery['terminal']): Promise<ScriptedResult & { count?: number }> => {
      if (!recorded) {
        recorded = true
        query.terminal = terminal
        queries.push(query)
      }
      const next = script.shift()
      return {
        data: next?.data ?? null,
        error: next?.error ?? null,
        count: Array.isArray(next?.data) ? next.data.length : null,
      } as unknown as ScriptedResult & { count?: number }
    }

    const api: Record<string, unknown> = {}
    const chain = () => api

    api.select = () => chain()
    api.insert = (values: unknown) => {
      query.operation = 'insert'
      query.values = values
      return chain()
    }
    api.update = (values: unknown) => {
      query.operation = 'update'
      query.values = values
      return chain()
    }
    api.upsert = (values: unknown, options?: { onConflict?: string }) => {
      query.operation = 'upsert'
      query.values = values
      query.onConflict = options?.onConflict
      return chain()
    }
    api.delete = () => {
      query.operation = 'delete'
      return chain()
    }
    api.eq = (column: string, value: unknown) => {
      query.filters.push({ column, value, operator: 'eq' })
      return chain()
    }
    api.in = (column: string, values: readonly unknown[]) => {
      query.filters.push({ column, value: values, operator: 'in' })
      return chain()
    }
    api.is = (column: string, value: unknown) => {
      query.filters.push({ column, value, operator: 'is' })
      return chain()
    }
    api.order = (column: string, options?: { ascending?: boolean }) => {
      query.order = { column, ...(options ?? {}) }
      return chain()
    }
    api.limit = (count: number) => {
      query.limit = count
      return chain()
    }
    api.single = () => settle('single')
    api.maybeSingle = () => settle('maybeSingle')
    // Thenable: a filtered query with no terminal call resolves on `await`.
    api.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      settle('await').then(onFulfilled, onRejected)

    return api
  }

  const client = {
    from: build,
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ fn, ...(args ? { args } : {}) })
      const next = rpcScript.shift()
      return { data: (next?.data ?? null) as never, error: next?.error ?? null }
    },
    auth: {
      getUser: async () => {
        const next = authScript.shift()
        return { data: { user: next?.user ?? null }, error: next?.error ?? null }
      },
    },
  } as unknown as SupabaseLikeClient

  return {
    client,
    queries,
    rpcCalls,
    push(result) {
      script.push(result)
    },
    pushEmpty(count) {
      for (let index = 0; index < count; index += 1) script.push({ data: null, error: null })
    },
    forTable(table, operation) {
      return queries.filter((query) => query.table === table && (!operation || query.operation === operation))
    },
    pushAuth(result) {
      authScript.push(result)
    },
    pushRpc(data, error) {
      rpcScript.push({ data, error: error ?? null })
    },
  }
}


