// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('architecture documentation consistency', () => {
  it('uses architecture.md as the linked source of truth across operator guides', () => {
    const architecture = read('docs/architecture.md')
    expect(architecture).toContain('Production live architecture')
    expect(architecture).toContain('DEMO DATA')
    expect(architecture).toContain('BACKEND UNAVAILABLE')
    expect(architecture).toContain('NEO4J UNAVAILABLE')
    for (const file of ['README.md', 'docs/deployment.md', 'docs/graph-database.md', 'docs/verification-neo4j.md']) {
      expect(read(file), file).toContain('architecture.md')
    }
  })

  it('does not contain stale claims that one provider is the verified primary database', () => {
    const checked = [
      read('README.md'), read('docs/deployment.md'), read('docs/graph-database.md'),
      read('docs/verification-neo4j.md'), read('.github/workflows/deploy-backend.yml'),
      read('server/graphApi.ts'), read('src/core/api.ts'), read('src/core/env.ts'),
    ].join('\n')
    expect(checked).not.toMatch(/Neo4j is the primary graph database/i)
    expect(checked).not.toMatch(/PostgreSQL is the only live database/i)
    expect(checked).not.toMatch(/public website is connected to Neo4j/i)
  })

  it('build workflow consumes the public API variable and preserves the project path', () => {
    const workflow = read('.github/workflows/deploy.yml')
    expect(workflow).toContain('VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL }}')
    expect(workflow).toContain('VITE_BASE_PATH: ${{ steps.target.outputs.base }}')
    expect(workflow).toContain('Verify embedded API configuration')
    // The rules live in one place (scripts/resolve-api-base.ts) so the build
    // and the workflow cannot drift apart, and the workflow must use that
    // place rather than re-implementing the checks.
    expect(workflow).toContain('scripts/resolve-api-base.ts')
    expect(read('scripts/resolve-api-base.ts')).toContain('must not point at localhost')
  })

  it('keeps one source of truth for the backend URL', () => {
    // The committed configuration and the environment variable are read by the
    // same resolver, and the workflow validates what the build embedded.
    const resolver = read('scripts/resolve-api-base.ts')
    expect(resolver).toContain('VITE_API_BASE_URL')
    expect(resolver).toContain('config/production-backend.json')
    const workflow = read('.github/workflows/deploy.yml')
    expect(workflow).toContain('config/production-backend.json')
    expect(read('config/production-backend.json')).toContain('/functions/v1')
  })
})
