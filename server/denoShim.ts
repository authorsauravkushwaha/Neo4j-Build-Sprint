/**
 * Narrow Node stand-in for the one Deno touch point in the shared core.
 *
 * `supabase/functions/_shared/core/http.ts` reads configuration defaults
 * through `globalThis.Deno?.env.get` (deliberately its only Deno reference, so
 * the core stays runtime-agnostic). When this module is loaded first, those
 * reads see `process.env` instead, and the request pipeline behaves exactly as
 * it does under Deno — without pulling in the Deno-only platform layer, which
 * imports `npm:@supabase/...` specifiers Node cannot resolve.
 */

const marker = globalThis as Record<string, unknown>

if (typeof marker['Deno'] === 'undefined') {
  marker['Deno'] = {
    env: {
      get: (key: string): string | undefined => process.env[key],
    },
  }
}

export {}
