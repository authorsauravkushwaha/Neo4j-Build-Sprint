/**
 * Edge Function: get-skill-details
 *
 * Skill with prerequisites, unlocks, resources and self-check. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/skills.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy get-skill-details --project-ref <your-ref>
 */
import { getSkillDetailsHandler } from '../_shared/handlers/skills.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(getSkillDetailsHandler, { methods: ['GET'] })


