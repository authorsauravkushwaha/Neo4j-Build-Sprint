/**
 * Edge Function: get-resources
 *
 * Searchable free-learning resource library. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/graph.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-resources --project-ref <your-ref>
 */
import { getResourcesHandler } from '../_shared/handlers/graph.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getResourcesHandler, { methods: ['GET', 'POST'] })


