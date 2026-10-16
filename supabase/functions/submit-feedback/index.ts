/**
 * Edge Function: submit-feedback
 *
 * Accepts feedback from guests and signed-in users. Rate limited.
 *
 * Generated as a thin shim: all logic lives in handlers/user.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy submit-feedback --project-ref <your-ref>
 */
import { submitFeedbackHandler } from '../_shared/handlers/user.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(submitFeedbackHandler, { methods: ['POST'] })


