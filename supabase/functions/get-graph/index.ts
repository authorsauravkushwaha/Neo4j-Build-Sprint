/**
 * Edge Function: get-graph
 *
 * Bounded knowledge-graph neighbourhood for the visual explorer. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/graph.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-graph --project-ref <your-ref>
 */
import { getGraphHandler } from '../_shared/handlers/graph.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getGraphHandler, { methods: ['GET'] })


