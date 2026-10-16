/**
 * Edge Function: get-careers
 *
 * Career catalogue and search. Public, cacheable.
 *
 * Generated as a thin shim: all logic lives in handlers/careers.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-careers --project-ref <your-ref>
 */
import { getCareersHandler } from '../_shared/handlers/careers.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getCareersHandler, { methods: ['GET'] })


