/**
 * Edge Function: manage-account
 *
 * Data export, progress reset and account-data deletion.
 *
 * Generated as a thin shim: all logic lives in handlers/user.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy manage-account --project-ref <your-ref>
 */
import { manageAccountHandler } from '../_shared/handlers/user.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(manageAccountHandler, { methods: ['POST'] })


