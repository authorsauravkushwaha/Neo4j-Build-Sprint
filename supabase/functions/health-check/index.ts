/**
 * Edge Function: health-check
 *
 * Reports graph/AI/storage configuration and honest limits. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/health.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy health-check --project-ref <your-ref>
 */
import { healthCheckHandler } from '../_shared/handlers/health.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(healthCheckHandler, { methods: ['GET'] })


