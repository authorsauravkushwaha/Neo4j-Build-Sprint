/**
 * Edge Function: get-career-details
 *
 * One career with skills, projects, resources and graph basis. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/careers.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-career-details --project-ref <your-ref>
 */
import { getCareerDetailsHandler } from '../_shared/handlers/careers.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getCareerDetailsHandler, { methods: ['GET'] })


