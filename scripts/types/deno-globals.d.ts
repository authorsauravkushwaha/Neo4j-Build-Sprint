/**
 * Minimal Deno surface used by `supabase/functions/_shared/platform/deno.ts`,
 * declared only so `tsconfig.functions.json` can typecheck the Edge Function
 * entry points under Node.
 *
 * This file is never shipped to Deno: it lives outside `supabase/functions/`,
 * and the Deno runtime provides its own (much larger) `Deno` global. It
 * declares exactly the two members the platform glue touches — `Deno.env.get`
 * and `Deno.serve` — so the checker verifies our use of them without pretending
 * to model the whole runtime.
 */
declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
  serve(handler: (request: Request) => Promise<Response>): void
}


