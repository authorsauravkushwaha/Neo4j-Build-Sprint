/**
 * Edge Function: generate-learning-roadmap
 *
 * Builds a dependency-aware weekly roadmap. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/analysis.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy generate-learning-roadmap --project-ref <your-ref>
 */
import { generateLearningRoadmapHandler } from '../_shared/handlers/analysis.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(generateLearningRoadmapHandler, { methods: ['POST'] })


