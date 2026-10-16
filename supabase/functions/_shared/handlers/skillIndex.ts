/**
 * Skill index endpoints.
 *
 *   GET /get-skills?q=&limit=
 *
 * Returns every skill and concept the graph holds, as a light row: id, name,
 * kind, difficulty and (for concepts) the subject it belongs to. It exists so
 * clients can search the curriculum without downloading the whole graph — the
 * command palette is the first caller, and a skill picker anywhere in the app
 * can be the next.
 *
 * Kept separate from `skills.ts` (the single-skill detail endpoint) on purpose:
 * this returns a list, that returns one node with its neighbourhood, and the two
 * have nothing in common except the word "skill".
 *
 * Public, like the rest of the read endpoints: a visitor must be able to look
 * around before creating an account. Rate limited, cached briefly, and it never
 * reflects a search term back into the response body.
 */
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { publicJson } from '../core/http.ts'
import { coerceQuery, parseOrThrow, skillIndexQuerySchema } from '../core/validate.ts'
import type { SkillIndexResponse } from '../core/contracts.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, metaFor, requireReader } from './shared.ts'

export async function getSkillsHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)
  await enforceRateLimit(runtime, request, runtime.config.limits.readPerMinute, 'skills-read')

  const input = parseOrThrow(
    skillIndexQuerySchema,
    coerceQuery(Object.fromEntries(request.url.searchParams.entries()), { numbers: ['limit'] }),
  )

  const started = Date.now()
  const { value: rows, truncated } = await reader.listSkillIndex({
    ...(input.q ? { q: input.q } : {}),
    limit: input.limit ?? 200,
  })

  const payload: SkillIndexResponse = {
    skills: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      difficulty: row.difficulty,
      ...(row.parentName ? { parentName: row.parentName } : {}),
    })),
    total: rows.length,
  }

  return publicJson(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { ms: Date.now() - started, truncated: truncated ?? false }) },
    // Longer than the career list: this is close to static and the palette loads
    // it once per session.
    { 'cache-control': 'public, max-age=600, stale-while-revalidate=1800' },
  )
}


