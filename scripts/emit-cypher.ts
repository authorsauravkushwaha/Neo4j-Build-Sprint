/**
 * Generates the Neo4j artefacts from the single source of truth
 * (`src/data/seed/knowledgeGraph.ts`):
 *
 *   neo4j/schema.cypher          constraints + indexes (idempotent)
 *   neo4j/seed.cypher            idempotent MERGE statements (literals inline,
 *                                runnable by hand in Neo4j Browser / cypher-shell)
 *   neo4j/seed.parameters.json   the same writes as `$params` payloads, used by
 *                                `npm run seed:neo4j` (parameterised, so the
 *                                loader never concatenates values into Cypher)
 *   neo4j/sample-queries.cypher  the queries the app actually runs, with comments
 *   neo4j/MANIFEST.json          counts + checksum of the generated content
 *
 * Both renderings come from the same templates, so the hand-runnable file and
 * the loader can never drift apart. Re-running the emitter is safe: the output
 * is deterministic (no timestamps, sorted edge groups).
 *
 * Usage:  npm run emit:cypher        (writes the files)
 *         npm run emit:cypher -- --check   (fails if the files are stale)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { knowledgeGraph } from '../src/data/seed/knowledgeGraph.ts'
import { validateDataset, type KnowledgeDataset, type SeedEdge } from '../supabase/functions/_shared/core/dataset.ts'
import { encodeAssessmentQuestions } from '../supabase/functions/_shared/core/assessmentCodec.ts'
import { QUERY_CATALOG, QUERY_PURPOSES } from '../supabase/functions/_shared/core/graphQuery.ts'
import { NODE_ID_PREFIXES } from '../supabase/functions/_shared/core/validate.ts'
import { NODE_LABELS } from '../supabase/functions/_shared/core/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'neo4j')
const checkOnly = process.argv.includes('--check')

/* ------------------------------------------------------------------ helpers */

/** Single-quoted Cypher string literal. Escapes everything Cypher treats specially. */
function lit(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Refusing to emit non-finite number: ${value}`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(lit).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${safeKey(k)}: ${lit(v)}`)
    return `{${entries.join(', ')}}`
  }
  const raw = String(value)
  // Unicode escapes for control characters keep the file safe to paste anywhere.
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `'${escaped}'`
}

function safeKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Unsafe property key: ${key}`)
  return key
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

const labelForId = (id: string): string | null => {
  const prefix = id.split(':')[0] as keyof typeof NODE_ID_PREFIXES
  return NODE_ID_PREFIXES[prefix] ?? null
}

/* ------------------------------------------------- node property extraction */

interface NodeRow {
  id: string
  label: string
  props: Record<string, unknown>
}

/** Properties we never copy onto the graph (import-only bookkeeping). */
const SKIP_PROPS = new Set(['id', 'label', 'subjectId', 'branchIds', 'skillIds'])

function nodeRows(dataset: KnowledgeDataset): NodeRow[] {
  const rows: NodeRow[] = []
  const push = <T extends { id: string }>(label: string, items: readonly T[]) => {
    for (const item of items) {
      const props: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(item as unknown as Record<string, unknown>)) {
        if (SKIP_PROPS.has(key) || value === undefined || value === null) continue
        props[key] = value
      }
      // Assessments: the free tier has no list-of-maps properties, so each
      // question is encoded as one string by the shared codec — the same module
      // the reader decodes with, so the two sides cannot drift apart.
      const questions = (item as unknown as { questions?: Array<{ prompt: string; options: string[]; answerIndex: number }> }).questions
      if (label === 'Assessment' && Array.isArray(questions)) {
        props.questions = encodeAssessmentQuestions(questions)
      }
      if (props.summary === undefined && typeof props.description === 'string') props.summary = props.description
      rows.push({ id: String(item.id), label, props })
    }
  }

  push('EngineeringBranch', dataset.branches)
  push('Career', dataset.careers)
  push('Subject', dataset.subjects)
  push('Concept', dataset.concepts)
  push('Skill', dataset.skills)
  push('ProgrammingLanguage', dataset.languages)
  push('Tool', dataset.tools)
  push('Project', dataset.projects)
  push('Resource', dataset.resources)
  push('LearningModule', dataset.modules)
  push('Assessment', dataset.assessments)

  return rows.sort((a, b) => (a.label === b.label ? a.id.localeCompare(b.id) : a.label.localeCompare(b.label)))
}

/* -------------------------------------------------------------- statements */

interface Statement {
  /** Stable key so anything that uses the statement can look it up. */
  tag: string
  /** Cypher with `$rows` (parameterised) references; never interpolated values. */
  template: string
  /** Property names written by this statement (for documentation). */
  props: string[]
}

function nodeStatements(rows: NodeRow[]): Statement[] {
  const byLabel = new Map<string, NodeRow[]>()
  for (const row of rows) {
    const list = byLabel.get(row.label) ?? []
    list.push(row)
    byLabel.set(row.label, list)
  }

  const statements: Statement[] = []
  for (const [label, items] of [...byLabel.entries()].sort()) {
    const props = [...new Set(items.flatMap((item) => Object.keys(item.props)))].sort()
    if (props.length === 0) continue
    const assignments = props.map((p) => `n.${safeKey(p)} = row.${safeKey(p)}`).join(',\n  ')
    for (const [batch, chunk] of chunks(items, 60).entries()) {
      statements.push({
        // tag carries the label + batch index so loader progress is readable
        tag: `nodes:${label}:${batch}`,
        template: `UNWIND $rows AS row
MERGE (n:${label} {id: row.id})
SET ${assignments}`,
        props,
        // row payload attached below by the caller
      })
      ;(statements[statements.length - 1] as Statement & { rows?: unknown[] }).rows = chunk.map((item) => ({
        id: item.id,
        ...item.props,
      }))
    }
  }
  return statements
}

/**
 * Relationship writes, grouped by (type, from-label, to-label).
 *
 * Both labels are written literally: a relationship type cannot be a parameter in
 * Cypher, and matching `(a:Skill {id: $from})` lets Neo4j use the uniqueness
 * constraint index instead of scanning every node.
 * Label/type come from validated ids, never from user input at runtime.
 */
function edgeStatements(edges: SeedEdge[]): Statement[] {
  const groups = new Map<string, SeedEdge[]>()
  for (const edge of edges) {
    const from = labelForId(edge.from)
    const to = labelForId(edge.to)
    if (!from || !to) throw new Error(`Cannot resolve labels for ${edge.from} -> ${edge.to}`)
    const key = `${edge.type}|${from}|${to}`
    const list = groups.get(key) ?? []
    list.push(edge)
    groups.set(key, list)
  }

  const statements: Statement[] = []
  for (const [key, items] of [...groups.entries()].sort()) {
    const [type, from, to] = key.split('|')
    const props: string[] = []
    if (items.some((e) => e.essential !== undefined)) props.push('essential')
    if (items.some((e) => e.weight !== undefined)) props.push('weight')
    if (items.some((e) => e.note !== undefined)) props.push('note')

    const assignments =
      props.length > 0
        ? '\n  ON CREATE SET ' + props.map((p) => `r.${safeKey(p)} = row.${safeKey(p)}`).join(', ') +
          '\n  ON MATCH SET ' + props.map((p) => `r.${safeKey(p)} = row.${safeKey(p)}`).join(', ')
        : ''

    for (const [batch, chunk] of chunks(items, 200).entries()) {
      statements.push({
        tag: `edges:${type}:${from}->${to}:${batch}`,
        template: `UNWIND $rows AS row
MATCH (a:${from} {id: row.from})
MATCH (b:${to} {id: row.to})
MERGE (a)-[r:${type}]->(b)${assignments}`,
        props,
      })
      ;(statements[statements.length - 1] as Statement & { rows?: unknown[] }).rows = chunk.map((edge) => {
        const row: Record<string, unknown> = { from: edge.from, to: edge.to }
        if (edge.essential !== undefined) row.essential = edge.essential
        if (edge.weight !== undefined) row.weight = edge.weight
        if (edge.note !== undefined) row.note = edge.note
        return row
      })
    }
  }
  return statements
}

type StatementWithRows = Statement & { rows?: unknown[] }

function renderForFile(statement: StatementWithRows): string {
  const rows = statement.rows ?? []
  const payload = rows.map((row) => lit(row)).join(',\n  ')
  return statement.template.replace('$rows', `[\n  ${payload}\n]`)
}

/* ----------------------------------------------------------------- outputs */

const header = (title: string, extra: string[] = []): string =>
  [
    '// ============================================================================',
    `// ${title}`,
    '//',
    '// GENERATED FILE — do not edit by hand.',
    '// Source: src/data/seed/knowledgeGraph.ts',
    '// Regenerate: npm run emit:cypher',
    ...extra.map((line) => `// ${line}`),
    '// ============================================================================',
    '',
  ].join('\n')

function schemaFile(): string {
  const lines: string[] = [
    header('GraphMentor AI — Neo4j schema (constraints + indexes)', [
      'Idempotent: safe to run on an existing database.',
      'Requires Neo4j 5.x (AuraDB Free qualifies).',
      '',
      'Neo4j Community/Aura supports uniqueness constraints and range indexes',
      'only; no full-text or vector indexes are used, so the free tier is enough.',
    ]),
    '// One uniqueness constraint per label guarantees MERGE is idempotent and',
    '// makes every id lookup an index seek.',
  ]
  for (const label of NODE_LABELS) {
    const name = `gm_${label.toLowerCase()}_id`
    lines.push(`CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE;`)
  }
  lines.push('')
  lines.push('// Range indexes used by search and by the resource catalogue filters.')
  lines.push('CREATE INDEX gm_career_name IF NOT EXISTS FOR (n:Career) ON (n.name);')
  lines.push('CREATE INDEX gm_skill_name IF NOT EXISTS FOR (n:Skill) ON (n.name);')
  lines.push('CREATE INDEX gm_skill_difficulty IF NOT EXISTS FOR (n:Skill) ON (n.difficulty);')
  lines.push('CREATE INDEX gm_resource_access IF NOT EXISTS FOR (n:Resource) ON (n.accessModel);')
  lines.push('CREATE INDEX gm_project_difficulty IF NOT EXISTS FOR (n:Project) ON (n.difficulty);')
  lines.push('CREATE INDEX gm_subject_name IF NOT EXISTS FOR (n:Subject) ON (n.name);')
  lines.push('')
  lines.push('// Relationship property index: the roadmap engine sorts by weight.')
  lines.push('CREATE INDEX gm_requires_skill_weight IF NOT EXISTS FOR ()-[r:REQUIRES_SKILL]-() ON (r.weight);')
  lines.push('')
  lines.push('// What the app expects to find, for a quick sanity check after seeding:')
  lines.push('//   MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes ORDER BY label;')
  lines.push('//   MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS rels ORDER BY rel;')
  lines.push('')
  return lines.join('\n')
}

function seedFile(statements: StatementWithRows[], counts: Record<string, number>): string {
  const parts: string[] = [
    header('GraphMentor AI — knowledge graph seed (idempotent)', [
      'Run after schema.cypher. Every statement is a MERGE keyed on `id`, so',
      're-running this file converges on the authored dataset instead of',
      'duplicating rows.',
      '',
      'In Neo4j Browser: paste the whole file and run it (statements are',
      'separated by `;`). With cypher-shell:',
      '  cat neo4j/schema.cypher neo4j/seed.cypher | cypher-shell -a <uri> -u <user> -p <password>',
      '',
      `Dataset version: ${knowledgeGraph.version} (${knowledgeGraph.updated})`,
      `Provenance: ${knowledgeGraph.provenance}`,
      '',
      `Nodes: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    ]),
  ]

  for (const [index, statement] of statements.entries()) {
    parts.push(`// --- [${index + 1}/${statements.length}] ${statement.tag}`)
    parts.push(renderForFile(statement) + ';')
    parts.push('')
  }
  return parts.join('\n')
}

function parametersFile(statements: StatementWithRows[]): string {
  const payload = {
    generatedFrom: {
      file: 'src/data/seed/knowledgeGraph.ts',
      version: knowledgeGraph.version,
      updated: knowledgeGraph.updated,
      provenance: knowledgeGraph.provenance,
    },
    statements: statements.map((statement) => ({
      tag: statement.tag,
      query: statement.template,
      parameters: { rows: statement.rows ?? [] },
    })),
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

function sampleQueriesFile(): string {
  const parts: string[] = [
    header('GraphMentor AI — the queries the application actually runs', [
      'These are the exact statements in supabase/functions/_shared/core/graphQuery.ts.',
      'The Edge Functions call them through the Neo4j HTTPS Query API with',
      'parameters (never string concatenation). Copy one into Neo4j Browser and',
      'replace the $parameters with literals to explore by hand.',
    ]),
  ]
  const entries = Object.entries(QUERY_CATALOG) as Array<[keyof typeof QUERY_CATALOG, string]>
  for (const [name, query] of entries) {
    parts.push(`// ${name} — ${QUERY_PURPOSES[name] ?? 'application query'}`)
    parts.push(query.trim() + ';')
    parts.push('')
  }

  parts.push('// ----------------------------------------------------------------------------')
  parts.push('// Practical exploration recipes (not used by the app)')
  parts.push('// ----------------------------------------------------------------------------')
  parts.push('')
  const recipes: Array<[string, string]> = [
    [
      'Everything reachable from one career, 3 hops out',
      `MATCH path = (c:Career {id: 'career:robotics-engineer'})-[*1..3]-(n)
RETURN path LIMIT 200;`,
    ],
    [
      'Longest prerequisite chain per career (which foundations bite hardest)',
      `MATCH (c:Career)-[:REQUIRES_SKILL]->(s:Skill)
MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
WHERE NOT (base)-[:REQUIRES]->(:Skill)
RETURN c.name AS career, s.name AS skill, length(path) AS depth,
       [n IN nodes(path) | n.name] AS chain
ORDER BY depth DESC LIMIT 25;`,
    ],
    [
      'Skills a career needs that have no free resource attached',
      `MATCH (c:Career {id: 'career:embedded-iot-engineer'})-[:REQUIRES_SKILL]->(s:Skill)
OPTIONAL MATCH (r:Resource)-[:TAUGHT_BY|COVERS]->(s)
WITH s, count(r) AS resources
WHERE resources = 0
RETURN s.id AS skill, s.name AS name ORDER BY name;`,
    ],
    [
      'Projects that teach the most skills inside one career',
      `MATCH (c:Career)-[:SUGGESTS_PROJECT]->(p:Project)
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
RETURN c.name AS career, p.name AS project, count(DISTINCT s) AS skills
ORDER BY skills DESC, project LIMIT 20;`,
    ],
    [
      'Resource coverage per access model (is the free path real?)',
      `MATCH (r:Resource)
RETURN r.accessModel AS accessModel, count(*) AS resources,
       sum(CASE WHEN r.verification = 'verified' THEN 1 ELSE 0 END) AS verified
ORDER BY resources DESC;`,
    ],
  ]
  for (const [title, query] of recipes) {
    parts.push(`// ${title}`)
    parts.push(query.trim())
    parts.push('')
  }
  return parts.join('\n')
}

/* --------------------------------------------------------------------- main */

function main(): void {
  const dataset = knowledgeGraph
  const validation = validateDataset(dataset)
  const errors = validation.issues.filter((issue) => issue.level === 'error')
  if (errors.length > 0) {
    console.error(`Refusing to emit Cypher: the dataset has ${errors.length} error(s).`)
    for (const issue of errors.slice(0, 20)) console.error(`  ${issue.where}: ${issue.message}`)
    process.exit(1)
  }

  const nodes = nodeStatements(nodeRows(dataset))
  const edges = edgeStatements(dataset.edges)
  const statements = [...nodes, ...edges]

  const counts: Record<string, number> = {}
  for (const row of nodeRows(dataset)) counts[row.label] = (counts[row.label] ?? 0) + 1

  const files: Record<string, string> = {
    'schema.cypher': schemaFile(),
    'seed.cypher': seedFile(statements, counts),
    'seed.parameters.json': parametersFile(statements),
    'sample-queries.cypher': sampleQueriesFile(),
  }

  const manifest = {
    generatedBy: 'scripts/emit-cypher.ts',
    datasetVersion: dataset.version,
    datasetUpdated: dataset.updated,
    provenance: dataset.provenance,
    counts: { ...counts, edges: dataset.edges.length },
    statements: statements.length,
    seedChecksum: createHash('sha256').update(files['seed.cypher']).digest('hex'),
    files: Object.keys(files),
  }
  files['MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n'

  mkdirSync(outDir, { recursive: true })

  let stale = 0
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(outDir, name)
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (checkOnly) {
      if (existing !== content) {
        console.error(`stale: neo4j/${name}`)
        stale += 1
      }
      continue
    }
    if (existing !== content) writeFileSync(path, content, 'utf8')
  }

  if (checkOnly) {
    if (stale > 0) {
      console.error(`\n${stale} generated file(s) are out of date. Run: npm run emit:cypher`)
      process.exit(1)
    }
    console.log('neo4j artefacts are up to date.')
    return
  }

  console.log(`Wrote ${Object.keys(files).length} files to neo4j/`)
  console.log(`  nodes: ${Object.values(counts).reduce((a, b) => a + b, 0)} across ${Object.keys(counts).length} labels`)
  console.log(`  edges: ${dataset.edges.length} across ${new Set(dataset.edges.map((e) => e.type)).size} relationship types`)
  console.log(`  statements: ${statements.length} (batched, all MERGE)`)

  for (const statement of statements) {
    if (statement.template.includes("'") && !statement.template.includes('$rows')) {
      throw new Error(`Statement ${statement.tag} contains an inline literal; templates must stay parameterised.`)
    }
  }
}

main()


