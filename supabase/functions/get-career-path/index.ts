/**
 * Edge Function: get-career-path
 *
 * Dependency-ordered pathway to a career. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/careers.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-career-path --project-ref <your-ref>
 */
import { getCareerPathHandler } from '../_shared/handlers/careers.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getCareerPathHandler, { methods: ['GET', 'POST'] })


