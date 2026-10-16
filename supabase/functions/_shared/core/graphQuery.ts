/**
 * The Cypher query catalogue.
 *
 * Hard rules enforced by this module (see docs/security.md):
 *  1. Every query is a constant string with `$parameters` — no string
 *     concatenation of user input anywhere. User text reaches Neo4j only as a
 *     bound parameter value.
 *  2. Variable-length patterns (`*1..4`) cannot take a parameter in Cypher, so
 *     depth is chosen by switching between pre-written query variants on an
 *     integer that has already been validated by zod (1..3 / 1..4 / 1..6).
 *  3. Node labels are never taken from user input: an id is validated, its
 *     prefix is mapped through `NODE_ID_PREFIXES`, and the label is emitted from
 *     that allow-list (see `labelClauseFromIds`).
 *  4. Every query declares a LIMIT bound by a `$limit` parameter that the graph
 *     client clamps to `NEO4J_MAX_ROWS`.
 *  5. Queries return *flat property maps* (never whole nodes), so the response
 *     decoder is independent of the Neo4j JSON serialisation version.
 */
import { NODE_ID_PREFIXES, idPrefixOf, type IdPrefix } from './validate.ts'

const NODE_PROJECTION = `
  n.id           AS id,
  head(labels(n)) AS label,
  n.name         AS name,
  n.summary      AS summary,
  n.difficulty   AS difficulty,
  n.url          AS url,
  n.provider     AS provider,
  n.accessModel  AS accessModel,
  n.format       AS format,
  n.slug         AS slug,
  n.essential    AS essential,
  n.tags         AS tags
`

/** Same projection without the `n.` prefix, for rows already bound to `n`. */
const NODE_PROJECTION_ALIASES = `
  n.id           AS id,
  head(labels(n)) AS label,
  n.name         AS name,
  n.summary      AS summary,
  n.difficulty   AS difficulty,
  n.url          AS url,
  n.provider     AS provider,
  n.accessModel  AS accessModel,
  n.format       AS format,
  n.slug         AS slug,
  n.essential    AS essential,
  n.tags         AS tags
`

export interface QueryVariant {
  /** Human purpose, used in docs and error messages. */
  purpose: string
  cypher: string
}

/* -------------------------------------------------------------------------- */
/* 1. Health / counts                                                          */
/* -------------------------------------------------------------------------- */

export const HEALTH_COUNTS = `CALL db.labels() YIELD label
CALL {
  WITH label
  MATCH (n) WHERE label IN labels(n)
  RETURN count(n) AS total
}
RETURN label AS label, total AS total
ORDER BY label ASC`

export const HEALTH_TOTAL = `MATCH (n)
RETURN count(n) AS nodes, 0 AS relationships`

export const HEALTH_TOTAL_RELS = `MATCH ()-[r]->()
RETURN count(r) AS relationships, 0 AS nodes`

/* -------------------------------------------------------------------------- */
/* 2. Career catalogue + search                                                */
/* -------------------------------------------------------------------------- */

/**
 * The search index: every skill and concept, with the subject a concept belongs
 * to (`HAS_CONCEPT` runs Subject → Concept in the seeded schema; skills have no
 * subject parent in this model, so `parentName` is null for them). Two labels in one static query — Cypher cannot parameterise labels, and
 * building query text from input is exactly how injection starts, so both
 * labels are literals and the limit is the only parameter.
 */
export const SKILL_INDEX = `MATCH (n)
WHERE n:Skill OR n:Concept
OPTIONAL MATCH (parent:Subject)-[:HAS_CONCEPT]->(n)
RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
       coalesce(n.difficulty, 'intermediate') AS difficulty, parent.name AS parentName
ORDER BY name ASC
LIMIT $limit`

export const CAREER_CATALOG = `MATCH (c:Career)
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
OPTIONAL MATCH (c)-[:REQUIRES_SKILL]->(s:Skill)
WITH c, collect(DISTINCT b.id) AS branchIds, collect(DISTINCT s.id) AS skillIds
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary,
       c.description AS description, c.difficulty AS difficulty, c.verification AS verification,
       branchIds AS branchIds, skillIds AS skillIds
ORDER BY name ASC
LIMIT $limit`

export const CAREER_SEARCH = `MATCH (c:Career)
WHERE ($q = '' OR toLower(c.name) CONTAINS $q OR toLower(coalesce(c.summary,'')) CONTAINS $q
       OR any(k IN coalesce(c.keywords, []) WHERE toLower(k) CONTAINS $q))
  AND ($branchId = '' OR EXISTS { MATCH (c)-[:BELONGS_TO]->(:EngineeringBranch {id: $branchId}) })
  AND ($difficulty = '' OR c.difficulty = $difficulty)
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
WITH c, collect(DISTINCT b.id) AS branchIds
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary,
       c.description AS description, c.difficulty AS difficulty, c.verification AS verification,
       branchIds AS branchIds
ORDER BY c.name ASC
SKIP $offset LIMIT $limit`

export const CAREER_DETAILS = `MATCH (c:Career {id: $careerId})
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
WITH c, collect(DISTINCT b { .id, .name }) AS branches
OPTIONAL MATCH (c)-[rs:REQUIRES_SKILL]->(s:Skill)
WITH c, branches, collect(DISTINCT s { .id, .name, .difficulty, essential: rs.essential, weight: rs.weight }) AS skills
OPTIONAL MATCH (c)-[:RELATED_TO]-(other:Career)
WITH c, branches, skills, collect(DISTINCT other { .id, .name }) AS related
OPTIONAL MATCH (c)-[:SUGGESTS_PROJECT]->(p:Project)
WITH c, branches, skills, related, collect(DISTINCT p { .id, .name, .difficulty }) AS projects
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary, c.description AS description,
       c.difficulty AS difficulty, c.verification AS verification, c.responsibilities AS responsibilities,
       c.portfolioIdeas AS portfolioIdeas, c.assumptions AS assumptions, c.typicalRoles AS typicalRoles,
       branches AS branches, skills AS skills, related AS related, projects AS projects
LIMIT 1`

export const CAREER_BRANCHES = `MATCH (b:EngineeringBranch)
OPTIONAL MATCH (c:Career)-[:BELONGS_TO]->(b)
RETURN b.id AS id, 'EngineeringBranch' AS label, b.name AS name, b.summary AS summary,
       count(DISTINCT c) AS careerCount
ORDER BY b.name ASC
LIMIT $limit`

/* -------------------------------------------------------------------------- */
/* 3. Skills, prerequisites and closure                                        */
/* -------------------------------------------------------------------------- */

export const CAREER_REQUIRED_SKILLS = `MATCH (c:Career {id: $careerId})-[rs:REQUIRES_SKILL]->(s:Skill)
RETURN s.id AS id, 'Skill' AS label, s.name AS name, s.summary AS summary, s.difficulty AS difficulty,
       coalesce(rs.essential, true) AS essential, coalesce(rs.weight, 0.5) AS weight
ORDER BY essential DESC, difficulty ASC, name ASC
LIMIT $limit`

/**
 * Prerequisite closure for a skill. `$DEPTH` variants are pre-written because
 * Cypher does not allow a parameter inside a variable-length pattern.
 */
const SKILL_PREREQ_CLOSURE_VARIANTS: Record<number, string> = {
  1: `(s)-[:REQUIRES*1..1]->(p:Skill)`,
  2: `(s)-[:REQUIRES*1..2]->(p:Skill)`,
  3: `(s)-[:REQUIRES*1..3]->(p:Skill)`,
  4: `(s)-[:REQUIRES*1..4]->(p:Skill)`,
  5: `(s)-[:REQUIRES*1..5]->(p:Skill)`,
  6: `(s)-[:REQUIRES*1..6]->(p:Skill)`,
}

export function skillPrereqClosure(depth: number): QueryVariant {
  const safeDepth = [1, 2, 3, 4, 5, 6].includes(depth) ? depth : 4
  return {
    purpose: `Prerequisites of one skill, up to ${safeDepth} step(s).`,
    cypher: `MATCH (s:Skill {id: $skillId})
MATCH ${SKILL_PREREQ_CLOSURE_VARIANTS[safeDepth]}
RETURN DISTINCT ${NODE_PROJECTION_ALIASES.replace(/\bn\./g, 'p.')}
ORDER BY name ASC
LIMIT $limit`,
  }
}

export function careerPrereqClosure(depth: number): QueryVariant {
  const safeDepth = [1, 2, 3, 4, 5, 6].includes(depth) ? depth : 4
  return {
    purpose: `All skills a career needs, including transitive prerequisites (max ${safeDepth} steps).`,
    cypher: `MATCH (c:Career {id: $careerId})-[rs:REQUIRES_SKILL]->(direct:Skill)
OPTIONAL MATCH (direct)-[:REQUIRES*0..${safeDepth}]->(p:Skill)
WITH c, rs, direct, collect(DISTINCT p) AS chain
UNWIND (CASE WHEN size(chain) = 0 THEN [direct] ELSE chain END) AS n
RETURN DISTINCT n.id AS id, 'Skill' AS label, n.name AS name, n.summary AS summary, n.difficulty AS difficulty,
       (n.id = direct.id) AS isDirect, coalesce(rs.essential, true) AS directEssential
ORDER BY name ASC
LIMIT $limit`,
  }
}

/** Prerequisite edges inside a bounded id set — the engine sorts on these. */
export const SKILL_EDGES_BY_IDS = `MATCH (a:Skill)-[r:REQUIRES]->(b:Skill)
WHERE a.id IN $ids AND b.id IN $ids
RETURN a.id AS from, b.id AS to, 'REQUIRES' AS type, coalesce(r.strength, 1.0) AS weight, r.note AS note
LIMIT $limit`

export const SKILL_DETAILS = `MATCH (s:Skill {id: $skillId})
OPTIONAL MATCH (s)-[r:REQUIRES]->(pre:Skill)
WITH s, collect(DISTINCT pre { .id, .name, strength: r.strength }) AS prerequisites
OPTIONAL MATCH (child:Skill)-[:REQUIRES]->(s)
WITH s, prerequisites, collect(DISTINCT child { .id, .name }) AS unlocks
OPTIONAL MATCH (s)-[:USES]->(t:Tool)
WITH s, prerequisites, unlocks, collect(DISTINCT t { .id, .name }) AS tools
OPTIONAL MATCH (s)-[:USES]->(l:ProgrammingLanguage)
WITH s, prerequisites, unlocks, tools, collect(DISTINCT l { .id, .name }) AS languages
OPTIONAL MATCH (s)-[:PRACTICED_BY]->(p:Project)
WITH s, prerequisites, unlocks, tools, languages, collect(DISTINCT p { .id, .name, .difficulty }) AS projects
OPTIONAL MATCH (s)-[:TAUGHT_BY]->(res:Resource)
RETURN s.id AS id, 'Skill' AS label, s.name AS name, s.summary AS summary, s.description AS description,
       s.difficulty AS difficulty, s.completionCriteria AS completionCriteria, s.practice AS practice,
       prerequisites AS prerequisites, unlocks AS unlocks, tools AS tools, languages AS languages,
       projects AS projects, collect(DISTINCT res { .id, .name, .provider, .url, .accessModel, .format }) AS resources
LIMIT 1`

export function downstreamClosure(depth: number): QueryVariant {
  const safeDepth = [1, 2, 3, 4, 5, 6].includes(depth) ? depth : 3
  return {
    purpose: `Skills and careers that become reachable after this skill (max ${safeDepth} steps).`,
    cypher: `MATCH (s:Skill {id: $skillId})
OPTIONAL MATCH (next:Skill)-[:REQUIRES*1..${safeDepth}]->(s)
WITH s, collect(DISTINCT next) AS downstream
OPTIONAL MATCH (down:Skill)-[:REQUIRES*1..${safeDepth}]->(s)
WHERE down.id <> s.id
WITH s, downstream, collect(DISTINCT down) AS allDown
OPTIONAL MATCH (c:Career)-[:REQUIRES_SKILL]->(sk:Skill)
WHERE sk.id = s.id OR sk IN allDown
RETURN collect(DISTINCT { id: c.id, name: c.name }) AS careers,
       collect(DISTINCT { id: x.id, name: x.name, difficulty: x.difficulty }) AS skills
LIMIT 1`,
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Projects                                                                 */
/* -------------------------------------------------------------------------- */

export const PROJECTS_FOR_SKILLS = `MATCH (p:Project)-[:BUILDS_SKILL]->(s:Skill)
WHERE s.id IN $skillIds
WITH p, collect(DISTINCT s.id) AS matchedSkills, count(DISTINCT s) AS matchCount
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(any:Skill)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, matchedSkills AS matchedSkills, collect(DISTINCT any.id) AS skillIds,
       matchCount AS matchCount
ORDER BY matchCount DESC, name ASC
LIMIT $limit`

export const PROJECTS_FOR_CAREER = `MATCH (c:Career {id: $careerId})-[:SUGGESTS_PROJECT]->(p:Project)
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, collect(DISTINCT s.id) AS skillIds
ORDER BY p.difficulty ASC, name ASC
LIMIT $limit`

export const PROJECT_DETAILS = `MATCH (p:Project {id: $projectId})
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
WITH p, collect(DISTINCT s { .id, .name }) AS skills
OPTIONAL MATCH (p)-[:USES]->(t)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, skills AS skills, collect(DISTINCT t { .id, .name }) AS toolNodes
LIMIT 1`

/* -------------------------------------------------------------------------- */
/* 5. Resources                                                                */
/* -------------------------------------------------------------------------- */

export const RESOURCES_FOR_SKILLS = `MATCH (r:Resource)-[:COVERS]->(s:Skill)
WHERE s.id IN $skillIds
WITH r, collect(DISTINCT s.id) AS skillIds, count(DISTINCT s) AS matchCount
OPTIONAL MATCH (r)-[:ASSUMES]->(presumed:Skill)
WITH r, skillIds, matchCount, collect(DISTINCT presumed.id) AS assumesIds, collect(DISTINCT presumed.name) AS assumesNames
RETURN r.id AS id, 'Resource' AS label, r.name AS name, r.summary AS summary, r.url AS url,
       r.provider AS provider, r.format AS format, r.difficulty AS difficulty, r.language AS language,
       r.accessModel AS accessModel, r.accessNote AS accessNote, r.outcomes AS outcomes,
       r.assumes AS assumes, r.limits AS limits, r.commitment AS commitment,
       r.estimatedHoursLow AS estimatedHoursLow, r.estimatedHoursHigh AS estimatedHoursHigh,
       r.lastVerified AS lastVerified,
       r.verification AS verification, skillIds AS skillIds, matchCount AS matchCount,
       assumesIds AS assumesIds, assumesNames AS assumesNames
ORDER BY matchCount DESC, r.name ASC
LIMIT $limit`

export const RESOURCES_FOR_SUBJECT = `MATCH (r:Resource)-[:COVERS]->(sub:Subject {id: $subjectId})
OPTIONAL MATCH (r)-[:ASSUMES]->(presumed:Skill)
WITH r, collect(DISTINCT presumed.id) AS assumesIds, collect(DISTINCT presumed.name) AS assumesNames
RETURN r.id AS id, 'Resource' AS label, r.name AS name, r.summary AS summary, r.url AS url,
       r.provider AS provider, r.format AS format, r.difficulty AS difficulty, r.language AS language,
       r.accessModel AS accessModel, r.accessNote AS accessNote, r.outcomes AS outcomes,
       r.assumes AS assumes, r.limits AS limits, r.commitment AS commitment,
       r.estimatedHoursLow AS estimatedHoursLow, r.estimatedHoursHigh AS estimatedHoursHigh,
       r.lastVerified AS lastVerified,
       r.verification AS verification, assumesIds AS assumesIds, assumesNames AS assumesNames
ORDER BY r.name ASC
LIMIT $limit`

export const RESOURCE_CATALOG = `MATCH (r:Resource)
WHERE $q = '' OR toLower(r.name) CONTAINS $q OR toLower(coalesce(r.summary,'')) CONTAINS $q
   OR toLower(coalesce(r.provider,'')) CONTAINS $q OR toLower(coalesce(r.limits,'')) CONTAINS $q
   OR any(outcome IN coalesce(r.outcomes, []) WHERE toLower(outcome) CONTAINS $q)
WITH r
WHERE ($format = '' OR r.format = $format)
  AND ($accessModel = '' OR r.accessModel = $accessModel)
  AND ($difficulty = '' OR r.difficulty = $difficulty)
OPTIONAL MATCH (r)-[:COVERS]->(target)
OPTIONAL MATCH (r)-[:ASSUMES]->(presumed:Skill)
RETURN r.id AS id, 'Resource' AS label, r.name AS name, r.summary AS summary, r.url AS url,
       r.provider AS provider, r.format AS format, r.difficulty AS difficulty, r.language AS language,
       r.accessModel AS accessModel, r.accessNote AS accessNote, r.outcomes AS outcomes,
       r.assumes AS assumes, r.limits AS limits, r.commitment AS commitment,
       r.estimatedHoursLow AS estimatedHoursLow, r.estimatedHoursHigh AS estimatedHoursHigh,
       r.lastVerified AS lastVerified,
       r.verification AS verification,
       collect(DISTINCT target.id) AS coversIds,
       collect(DISTINCT target.name) AS coversNames,
       collect(DISTINCT presumed.id) AS assumesIds,
       collect(DISTINCT presumed.name) AS assumesNames
ORDER BY r.provider ASC, r.name ASC
SKIP $offset LIMIT $limit`

export const RESOURCE_DETAILS = `MATCH (r:Resource {id: $resourceId})
OPTIONAL MATCH (r)-[:COVERS]->(c)
OPTIONAL MATCH (r)-[:ASSUMES]->(presumed:Skill)
RETURN r.id AS id, 'Resource' AS label, r.name AS name, r.summary AS summary, r.url AS url,
       r.provider AS provider, r.format AS format, r.difficulty AS difficulty, r.language AS language,
       r.accessModel AS accessModel, r.accessNote AS accessNote, r.outcomes AS outcomes,
       r.assumes AS assumes, r.limits AS limits, r.commitment AS commitment,
       r.estimatedHoursLow AS estimatedHoursLow, r.estimatedHoursHigh AS estimatedHoursHigh,
       r.lastVerified AS lastVerified,
       r.verification AS verification, collect(DISTINCT c { .id, .name }) AS covers,
       collect(DISTINCT presumed.id) AS assumesIds, collect(DISTINCT presumed.name) AS assumesNames
LIMIT 1`

/* -------------------------------------------------------------------------- */
/* 6. Routes: skill -> career                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Shortest learning routes from a skill the student already has to something the
 * target career requires. Returns up to `$limit` distinct routes, ordered by
 * hops. `shortestPath` is bounded by a literal upper length; the graph client
 * additionally enforces a query timeout.
 */
export const ROUTES_SKILL_TO_CAREER = `MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(target:Skill)
MATCH p = shortestPath((start:Skill {id: $fromSkillId})-[:REQUIRES*0..6]->(target))
WHERE length(p) >= 1
RETURN [n IN nodes(p) | n.id] AS ids,
       [n IN nodes(p) | n.name] AS names,
       [n IN nodes(p) | n.difficulty] AS difficulties,
       target.id AS targetId,
       target.name AS targetName,
       length(p) AS hops
ORDER BY hops ASC, targetName ASC
LIMIT $limit`

/* -------------------------------------------------------------------------- */
/* 7. Neighbourhood for visualisation                                         */
/* -------------------------------------------------------------------------- */

export interface NeighbourhoodSpec {
  seedLabel?: string
  depth: number
  labels: string[]
  relations: string[]
  difficulty?: string
}

/** Maps validated id prefixes to Neo4j labels, never user text. */
export function labelClauseFromIds(prefix: IdPrefix): string {
  return NODE_ID_PREFIXES[prefix]
}

export function labelForNodeId(id: string): string | null {
  const prefix = idPrefixOf(id)
  return prefix ? labelClauseFromIds(prefix) : null
}

/**
 * Neighbourhood of one node.
 *
 * Only two things are ever interpolated: the seed label (derived from the
 * validated id prefix through `NODE_ID_PREFIXES`, never from raw input) and the
 * depth variant (an integer switch, because Cypher forbids parameters in
 * variable-length patterns). Node labels and relationship types are *compared as
 * bound parameters* (`head(labels(n)) IN $labels`), so the filter itself is fully
 * parameterised.
 */
export function neighbourhoodQuery(seedLabel: string, depth: number): QueryVariant {
  const safeDepth = [1, 2, 3].includes(depth) ? depth : 1
  const pattern =
    safeDepth === 1
      ? 'MATCH (seed)-[r]-(n)'
      : safeDepth === 2
        ? 'MATCH (seed)-[]-(mid)-[]-(n)'
        : 'MATCH (seed)-[]-(mid)-[]-(far)-[]-(n)'
  const relationFilter = safeDepth === 1 ? 'AND type(r) IN $relations' : ''
  return {
    purpose: `Return the ${safeDepth}-hop neighbourhood of a node, bounded by $limit.`,
    cypher: `MATCH (seed:${seedLabel} {id: $seedId})
${pattern}
WHERE n.id <> seed.id
  AND head(labels(n)) IN $labels
  ${relationFilter}
  AND ($difficulty = '' OR n.difficulty IS NULL OR n.difficulty = $difficulty)
WITH DISTINCT n
RETURN DISTINCT ${NODE_PROJECTION_ALIASES}
ORDER BY label ASC, name ASC
LIMIT $limit`,
  }
}

/**
 * Edges between a set of ids. Kept separate from the node query so the client can
 * guarantee "every drawn edge has both endpoints present".
 */
export function edgesAmongIds(_relations: readonly string[] = []): QueryVariant {
  return {
    purpose: 'Edges inside a bounded node id set (all endpoints must already be in the result).',
    cypher: `MATCH (a)-[r]->(b)
WHERE a.id IN $ids AND b.id IN $ids
  AND ($relations = [] OR type(r) IN $relations)
RETURN DISTINCT a.id AS from, b.id AS to, type(r) AS type, r.weight AS weight, r.note AS note,
       head(labels(a)) AS fromLabel, head(labels(b)) AS toLabel
LIMIT $limit`,
  }
}

/** Curated overview subgraph for a career (used when no seed node is selected). */
export const CAREER_OVERVIEW_SUBGRAPH = `MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)
WITH c, collect(DISTINCT s) AS skills
UNWIND skills AS s
OPTIONAL MATCH (s)-[:USES]->(t)
OPTIONAL MATCH (s)-[:PRACTICED_BY]->(p:Project)
OPTIONAL MATCH (s)-[:TAUGHT_BY]->(r:Resource)
WITH c, skills, collect(DISTINCT t) AS tools, collect(DISTINCT p) AS projects, collect(DISTINCT r) AS resources
WITH c, skills,
     [x IN tools WHERE x IS NOT NULL] AS tools,
     [x IN projects WHERE x IS NOT NULL] AS projects,
     [x IN resources WHERE x IS NOT NULL] AS resources
WITH (skills + tools) AS base, projects, resources, c
UNWIND base AS n
RETURN DISTINCT ${NODE_PROJECTION_ALIASES}
LIMIT $limit`

/** Node counts per label, used by Settings to show what is loaded. */
export const LABEL_COUNTS = `MATCH (n)
UNWIND labels(n) AS label
RETURN label AS label, count(*) AS total
ORDER BY total DESC`

/** Everything a career's skills need, used to size the roadmap engine input. */
export const SKILL_LOOKUP_BY_IDS = `MATCH (s:Skill)
WHERE s.id IN $ids
RETURN s.id AS id, 'Skill' AS label, s.name AS name, s.summary AS summary, s.difficulty AS difficulty,
       s.estimatedHoursLow AS estimatedHoursLow, s.estimatedHoursHigh AS estimatedHoursHigh,
       s.completionCriteria AS completionCriteria, s.practice AS practice
ORDER BY name ASC
LIMIT $limit`

export const ASSESSMENTS_FOR_SKILLS = `MATCH (a:Assessment)-[:ASSESSES]->(s:Skill)
WHERE s.id IN $ids
RETURN a.id AS id, 'Assessment' AS label, a.name AS name, a.summary AS summary, a.difficulty AS difficulty,
       a.questions AS questions, s.id AS skillId
ORDER BY name ASC
LIMIT $limit`

export const MODULES_FOR_CAREER = `MATCH (m:LearningModule)-[:TEACHES]->(s:Skill)
WHERE ($careerId = '' OR EXISTS { MATCH (:Career {id: $careerId})-[:REQUIRES_SKILL]->(s) })
RETURN m.id AS id, 'LearningModule' AS label, m.name AS name, m.summary AS summary,
       collect(DISTINCT s.id) AS skillIds
ORDER BY name ASC
LIMIT $limit`

/** Exported for documentation generation and tests. */
export const QUERY_CATALOG = {
  HEALTH_COUNTS,
  HEALTH_TOTAL,
  HEALTH_TOTAL_RELS,
  CAREER_CATALOG,
  CAREER_SEARCH,
  SKILL_INDEX,
  CAREER_DETAILS,
  CAREER_BRANCHES,
  CAREER_REQUIRED_SKILLS,
  SKILL_EDGES_BY_IDS,
  SKILL_DETAILS,
  PROJECTS_FOR_SKILLS,
  PROJECTS_FOR_CAREER,
  PROJECT_DETAILS,
  RESOURCES_FOR_SKILLS,
  RESOURCES_FOR_SUBJECT,
  RESOURCE_CATALOG,
  RESOURCE_DETAILS,
  ROUTES_SKILL_TO_CAREER,
  CAREER_OVERVIEW_SUBGRAPH,
  LABEL_COUNTS,
  SKILL_LOOKUP_BY_IDS,
  ASSESSMENTS_FOR_SKILLS,
  MODULES_FOR_CAREER,
} as const

export const QUERY_PURPOSES: Record<keyof typeof QUERY_CATALOG, string> = {
  HEALTH_COUNTS: 'Count nodes per label (used by health-check and the empty-state hint).',
  HEALTH_TOTAL: 'Total node count.',
  HEALTH_TOTAL_RELS: 'Total relationship count.',
  CAREER_CATALOG: 'Full career list for the explorer and the guest demo.',
  CAREER_SEARCH: 'Parameterised career search with branch/difficulty filters.',
  CAREER_DETAILS: 'One career with branches, required skills, related careers and projects.',
  CAREER_BRANCHES: 'Engineering branch list with career counts.',
  CAREER_REQUIRED_SKILLS: 'Direct skills a career requires, with essential/weight flags.',
  SKILL_EDGES_BY_IDS: 'Prerequisite edges inside a bounded id set.',
  SKILL_DETAILS: 'One skill with prerequisites, unlocks, tools, projects and resources.',
  PROJECTS_FOR_SKILLS: 'Projects that build a given set of skills, ranked by overlap.',
  PROJECTS_FOR_CAREER: 'Projects suggested by a career.',
  PROJECT_DETAILS: 'One project with objectives, milestones, safety notes and skills.',
  RESOURCES_FOR_SKILLS: 'Resources covering a given set of skills.',
  RESOURCES_FOR_SUBJECT: 'Resources covering a subject.',
  RESOURCE_CATALOG: 'Searchable resource library with filters.',
  RESOURCE_DETAILS: 'One resource with the entities it covers.',
  ROUTES_SKILL_TO_CAREER: 'Shortest routes from a known skill to a target career.',
  CAREER_OVERVIEW_SUBGRAPH: 'Curated subgraph for the career overview graph view.',
  LABEL_COUNTS: 'Node counts per label.',
  SKILL_INDEX: 'Every skill and concept, for the command palette search index.',
  SKILL_LOOKUP_BY_IDS: 'Skill metadata (effort ranges, criteria) for the roadmap engine.',
  ASSESSMENTS_FOR_SKILLS: 'Short self-check questions attached to skills.',
  MODULES_FOR_CAREER: 'Learning modules relevant to a career.',
}

/** Documents the query catalogue in Markdown (used by docs + a test). */
export function queryCatalogMarkdown(): string {
  const rows = Object.entries(QUERY_PURPOSES).map(([key, purpose]) => {
    const cypher = QUERY_CATALOG[key as keyof typeof QUERY_CATALOG]
    const firstLine = cypher.split('\n')[0].slice(0, 110)
    return `| \`${key}\` | ${purpose} | \`${firstLine.replace(/\|/g, '\\|')}\` |`
  })
  return ['| Query | Purpose | First line |', '| --- | --- | --- |', ...rows].join('\n')
}

// Silence "unused" for the raw projection constant kept for documentation value.
export const _nodeProjection = NODE_PROJECTION


