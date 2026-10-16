/**
 * Edge Function: auth-guard
 *
 * Pre-flight rate limiting for sign-in attempts.
 *
 * Generated as a thin shim: all logic lives in handlers/authGuard.ts so it can
 * be unit-tested in Node. Deploy with:
 *   supabase functions deploy auth-guard --project-ref <your-ref>
 *
 * This endpoint is public by necessity — a learner asking to sign in has no token
 * yet. It therefore does the least it can: count, answer, and learn nothing.
 */
import { authGuardHandler } from '../_shared/handlers/authGuard.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(authGuardHandler, { methods: ['POST'] })


