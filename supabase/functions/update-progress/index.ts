/**
 * Edge Function: update-progress
 *
 * Reads saved roadmaps and updates task progress; supports confirmed reset.
 *
 * Generated as a thin shim: all logic lives in handlers/user.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy update-progress --project-ref <your-ref>
 */
import { updateProgressHandler } from '../_shared/handlers/user.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(updateProgressHandler, { methods: ['GET', 'POST'] })


