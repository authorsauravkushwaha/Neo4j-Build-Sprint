/**
 * The Edge Function entry points must be callable through `serve()`.
 *
 * Every handler in `supabase/functions/_shared/handlers/` is declared
 * `(runtime, request)`. `serve()` in `_shared/platform/deno.ts` is the only
 * thing that ever calls them in a real deployment, and it once declared the
 * opposite argument order — which TypeScript would have caught immediately,
 * except that no tsconfig included the entry points, so nothing ever checked.
 * Every function would have failed on its first request in Deno while every
 * Node test stayed green.
 *
 * Two defences, both here: `tsconfig.functions.json` typechecks the entry
 * points (`npm run typecheck:functions`, run in CI), and this test pins the
 * wiring in the source so a "fix" that silences the checker by loosening the
 * types still fails.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const deno = read('supabase/functions/_shared/platform/deno.ts')

describe('serve() wiring', () => {
  it('RuntimeHandler takes the runtime first, matching every handler', () => {
    expect(deno).toContain(
      'export type RuntimeHandler = (runtime: Runtime, request: ApiRequest) => Promise<HttpResponse>',
    )
  })

  it('serve adapts in that order — it does not pass the request as the runtime', () => {
    expect(deno).toContain('handler: (request) => handler(createRequestRuntime(rawRequest), request)')
    expect(deno).not.toContain('handler(request, params')
    expect(deno).not.toContain('options.handler({ ...request }, {}, runtime)')
  })

  it('every entry point passes a (runtime, request) handler to serve', () => {
    const functionsDir = join(root, 'supabase', 'functions')
    const entryPoints = readdirSync(functionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => join(functionsDir, entry.name, 'index.ts'))

    expect(entryPoints.length).toBeGreaterThanOrEqual(18)
    for (const file of entryPoints) {
      const source = readFileSync(file, 'utf8')
      const match = source.match(/import \{ (\w+Handler) \} from '(\.\.\/_shared\/handlers\/[\w.]+\.ts)'/)
      expect(match, `${file} imports one handler`).not.toBeNull()
      const [, handlerName, handlerPath] = match as unknown as [string, string, string]
      expect(source).toContain(`serve(${handlerName},`)

      const handlerSource = read(join(root, 'supabase', 'functions', handlerPath.replace('../', '')))
      const declaration = new RegExp(`export async function ${handlerName}\\(runtime: Runtime, request: ApiRequest\\)`)
      expect(declaration.test(handlerSource), `${handlerName} is declared (runtime, request)`).toBe(true)
    }
  })

  it('the functions project is part of the repo, so the checker cannot be dropped quietly', () => {
    const config = JSON.parse(read('tsconfig.functions.json')) as { include?: string[] }
    expect(config.include).toContain('supabase/functions')
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['typecheck:functions']).toBe('tsc -p tsconfig.functions.json')
  })
})


