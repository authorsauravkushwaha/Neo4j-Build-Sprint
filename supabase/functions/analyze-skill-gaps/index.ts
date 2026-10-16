/**
 * Edge Function: analyze-skill-gaps
 *
 * Deterministic skill-gap analysis with transparent scoring. Public.
 *
 * Generated as a thin shim: all logic lives in handlers/analysis.ts so it can be
 * unit-tested in Node. Deploy with:
 *   supabase functions deploy analyze-skill-gaps --project-ref <your-ref>
 */
import { analyzeSkillGapsHandler } from '../_shared/handlers/analysis.ts'
import { serve } from '../_shared/platform/deno.ts'

serve(analyzeSkillGapsHandler, { methods: ['POST'] })


