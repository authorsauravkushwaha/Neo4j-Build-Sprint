/**
 * Edge Function: manage-bookmarks
 *
 * Adds, removes and lists the caller’s bookmarks.
 *
 * Generated as a thin shim: all logic lives in handlers/user.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy manage-bookmarks --project-ref <your-ref>
 */
import { manageBookmarksHandler } from '../_shared/handlers/user.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(manageBookmarksHandler, { methods: ['GET', 'POST'] })


