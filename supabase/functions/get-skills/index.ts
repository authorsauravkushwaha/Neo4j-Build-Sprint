/**
 * Edge Function: get-skills
 *
 * The searchable index of every skill and concept in the graph. Public,
 * cacheable. Used by the command palette (Cmd/Ctrl+K), and available to any
 * screen that needs to offer a skill picker.
 *
 * Thin shim: all logic lives in handlers/skillIndex.ts so it can be unit-tested
 * in Node. Deploy with:
 *   supabase functions deploy get-skills --project-ref <your-ref>
 */
import { getSkillsHandler } from '../_shared/handlers/skillIndex.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getSkillsHandler, { methods: ['GET'] })


