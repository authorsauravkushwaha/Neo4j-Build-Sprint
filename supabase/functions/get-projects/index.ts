/**
 * Edge Function: get-projects
 *
 * Project recommendations ranked by skill coverage. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/graph.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-projects --project-ref <your-ref>
 */
import { getProjectsHandler } from '../_shared/handlers/graph.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getProjectsHandler, { methods: ['GET'] })


