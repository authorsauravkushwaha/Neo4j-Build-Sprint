/**
 * Edge Function: save-roadmap
 *
 * Saves an authenticated user’s roadmap (RLS-protected).
 *
 * Generated as a thin shim: all logic lives in handlers/user.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy save-roadmap --project-ref <your-ref>
 */
import { saveRoadmapHandler } from '../_shared/handlers/user.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(saveRoadmapHandler, { methods: ['POST'] })


