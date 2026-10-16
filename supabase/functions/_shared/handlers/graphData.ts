/**
 * HTTP-facing wrapper around the shared career-slice loader.
 *
 * The loader itself lives in `core/careerSlice.ts` so the browser demo mode can
 * reuse it; this file only adds the Edge Function concerns: request ids and the
 * user-facing `AppError` messages.
 *
 * Both `analyze-skill-gaps` and `generate-learning-roadmap` call this, so the two
 * endpoints always see exactly the same slice for a given career.
 */
import { AppError } from '../core/errors.ts'
import { loadCareerSlice as loadSlice, type CareerSlice, type LoadCareerSliceOptions } from '../core/careerSlice.ts'
import type { GraphReader } from '../core/graphReader.ts'
import type { ApiRequest } from '../core/http.ts'

export type { CareerSlice, LoadCareerSliceOptions }

export async function loadCareerSlice(
  reader: GraphReader,
  careerId: string,
  request: ApiRequest,
  options: LoadCareerSliceOptions = {},
): Promise<CareerSlice> {
  return loadSlice(reader, careerId, {
    ...options,
    onFailure: (failure) => {
      if (failure.kind === 'career-missing') {
        throw new AppError('not_found', {
          requestId: request.requestId,
          publicMessage: `The knowledge graph has no career with identifier "${failure.careerId}". Open Explore Careers to see the available career paths.`,
        })
      }
      throw new AppError('not_found', {
        requestId: request.requestId,
        publicMessage: `"${failure.careerName}" has no skills recorded in the graph yet, so no analysis is possible. The graph may need seeding.`,
      })
    },
  })
}


