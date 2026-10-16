/**
 * Edge Function: mentor-chat
 *
 * Graph-grounded AI mentor with a deterministic fallback. Rate limited.
 *
 * Generated as a thin shim: all logic lives in handlers/mentor.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy mentor-chat --project-ref <your-ref>
 */
import { mentorChatHandler } from '../_shared/handlers/mentor.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(mentorChatHandler, { methods: ['POST'] })


