/**
 * A `GraphReader` backed by the deployment's own PostgreSQL database
 * (`server/graphStore.ts`).
 *
 * How it works, and why it is honest:
 *   - Every call first reads the store's revision with one small SQL query.
 *     When the revision changed (a seed, a `select graph.bump()` after an
 *     operator edit), the dataset is re-read from the tables and the query
 *     engine is rebuilt; otherwise the engine built from the last database
 *     read serves the call. The revision check is rate-limited to once per
 *     second so a request storm costs at most one cheap lookup.
 *   - The engine itself is the same `createLocalReader` the browser demo and
 *     the test-suite use — one query implementation, exhaustively tested —
 *     but it is built from rows that came out of the database, never from the
 *     bundled file. Delete or edit rows in the database and the answers
 *     change: the database is the source of truth, the bundle only seeds it.
 *   - `totals()` is always a live SQL COUNT, so the health check reports what
 *     the database actually holds, not what the build expected it to hold.
 *   - An unseeded or invalid store throws instead of serving a made-up graph;
 *     the health endpoint then reports the graph as unreachable rather than
 *     pretending everything is fine.
 */
import { createLocalReader } from '../supabase/functions/_shared/core/localReader.ts'
import type {
  CareerSearchInput,
  GraphReader,
  GraphTotals,
  NeighborhoodInput,
  ProjectQuery,
  ReadOptions,
  ReadResult,
  ResourceQuery,
  SkillIndexInput,
} from '../supabase/functions/_shared/core/graphReader.ts'
import type { RelationType } from '../supabase/functions/_shared/core/types.ts'
import { graphCounts, graphRevision, loadDataset, type TransactionalGraphDatabase } from './graphStore.ts'

export interface PostgresGraphReaderOptions {
  /**
   * At most one revision lookup per this interval (ms). Reads in between are
   * served by the engine built from the last database read. Default 1000.
   */
  reloadIntervalMs?: number
  /** Overrides the provenance sentence (tests). */
  provenance?: string
}

const DEFAULT_PROVENANCE =
  'Live PostgreSQL knowledge graph served from this deployment’s own database ' +
  '(seeded with the GraphMentor curriculum from neo4j/seed equivalents). Every ' +
  'answer is read from database rows, not from a bundled file.'

export function createPostgresGraphReader(db: TransactionalGraphDatabase, options: PostgresGraphReaderOptions = {}): GraphReader {
  const reloadIntervalMs = options.reloadIntervalMs ?? 1000

  let cache: { revision: number; checkedAt: number; reader: ReturnType<typeof createLocalReader> } | null = null

  async function current(): Promise<ReturnType<typeof createLocalReader>> {
    const now = Date.now()
    if (cache && now - cache.checkedAt < reloadIntervalMs) return cache.reader
    const revision = await graphRevision(db)
    if (cache && cache.revision === revision) {
      cache.checkedAt = now
      return cache.reader
    }
    const dataset = await loadDataset(db)
    if (!dataset) {
      // Empty store: no invented graph. The health check surfaces this as
      // unreachable-with-a-seed-hint, which is exactly the truth of it.
      throw new Error('The graph database has not been seeded yet (npm run seed:graphdb).')
    }
    cache = { revision, checkedAt: now, reader: createLocalReader(dataset) }
    return cache.reader
  }

  return {
    kind: 'postgres',
    provenance: options.provenance ?? DEFAULT_PROVENANCE,
    configured: true,

    /* totals() deliberately bypasses the cache: the health check asks "what
     * does the database hold right now?", and SQL answers that. */
    async totals(_options?: ReadOptions): Promise<ReadResult<GraphTotals>> {
      const started = Date.now()
      const counts = await graphCounts(db)
      return { value: counts, ms: Date.now() - started }
    },

    listCareers: async (limit, o) => (await current()).listCareers(limit, o),
    searchCareers: async (input: CareerSearchInput, o) => (await current()).searchCareers(input, o),
    listBranches: async (limit, o) => (await current()).listBranches(limit, o),
    getCareer: async (careerId, o) => (await current()).getCareer(careerId, o),
    getCareerSkills: async (careerId, o) => (await current()).getCareerSkills(careerId, o),
    getCareerClosure: async (careerId, depth, limit, o) => (await current()).getCareerClosure(careerId, depth, limit, o),
    getSkillEdges: async (ids, limit, o) => (await current()).getSkillEdges(ids, limit, o),
    listSkillIndex: async (input: SkillIndexInput, o) => (await current()).listSkillIndex(input, o),
    getSkill: async (skillId, o) => (await current()).getSkill(skillId, o),
    getSkillClosure: async (skillId, depth, limit, o) => (await current()).getSkillClosure(skillId, depth, limit, o),
    getDownstream: async (skillId, depth, o) => (await current()).getDownstream(skillId, depth, o),
    getRoutes: async (careerId, fromSkillId, limit, o) => (await current()).getRoutes(careerId, fromSkillId, limit, o),
    getNeighborhood: async (input: NeighborhoodInput, o) => (await current()).getNeighborhood(input, o),
    getEdgesAmong: async (ids: string[], relations: RelationType[] | undefined, limit: number, o) =>
      (await current()).getEdgesAmong(ids, relations, limit, o),
    findProjects: async (query: ProjectQuery, o) => (await current()).findProjects(query, o),
    findResources: async (query: ResourceQuery, o) => (await current()).findResources(query, o),
    getAssessments: async (skillIds, limit, o) => (await current()).getAssessments(skillIds, limit, o),
    getModules: async (careerId: string | undefined, limit: number, o) => (await current()).getModules(careerId, limit, o),
  }
}
