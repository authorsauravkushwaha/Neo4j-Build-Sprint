// ============================================================================
// GraphMentor AI — the queries the application actually runs
//
// GENERATED FILE — do not edit by hand.
// Source: src/data/seed/knowledgeGraph.ts
// Regenerate: npm run emit:cypher
// These are the exact statements in supabase/functions/_shared/core/graphQuery.ts.
// The Edge Functions call them through the Neo4j HTTPS Query API with
// parameters (never string concatenation). Copy one into Neo4j Browser and
// replace the $parameters with literals to explore by hand.
// ============================================================================

// HEALTH_COUNTS — Count nodes per label (used by health-check and the empty-state hint).
CALL db.labels() YIELD label
CALL {
  WITH label
  MATCH (n) WHERE label IN labels(n)
  RETURN count(n) AS total
}
RETURN label AS label, total AS total
ORDER BY label ASC;

// HEALTH_TOTAL — Total node count.
MATCH (n)
RETURN count(n) AS nodes, 0 AS relationships;

// HEALTH_TOTAL_RELS — Total relationship count.
MATCH ()-[r]->()
RETURN count(r) AS relationships, 0 AS nodes;

// CAREER_CATALOG — Full career list for the explorer and the guest demo.
MATCH (c:Career)
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
OPTIONAL MATCH (c)-[:REQUIRES_SKILL]->(s:Skill)
WITH c, collect(DISTINCT b.id) AS branchIds, collect(DISTINCT s.id) AS skillIds
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary,
       c.description AS description, c.difficulty AS difficulty, c.verification AS verification,
       branchIds AS branchIds, skillIds AS skillIds
ORDER BY name ASC
LIMIT $limit;

// CAREER_SEARCH — Parameterised career search with branch/difficulty filters.
MATCH (c:Career)
WHERE ($q = '' OR toLower(c.name) CONTAINS $q OR toLower(coalesce(c.summary,'')) CONTAINS $q
       OR any(k IN coalesce(c.keywords, []) WHERE toLower(k) CONTAINS $q))
  AND ($branchId = '' OR EXISTS { MATCH (c)-[:BELONGS_TO]->(:EngineeringBranch {id: $branchId}) })
  AND ($difficulty = '' OR c.difficulty = $difficulty)
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
OPTIONAL MATCH (c)-[:REQUIRES_SKILL]->(s:Skill)
WITH c, collect(DISTINCT b.id) AS branchIds, collect(DISTINCT s.id) AS skillIds
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary,
       c.description AS description, c.difficulty AS difficulty, c.verification AS verification,
       branchIds AS branchIds, skillIds AS skillIds
ORDER BY c.name ASC
SKIP $offset LIMIT $limit;

// SKILL_INDEX — Every skill and concept, for the command palette search index.
MATCH (n)
WHERE n:Skill OR n:Concept
OPTIONAL MATCH (parent:Subject)-[:HAS_CONCEPT]->(n)
RETURN n.id AS id, n.name AS name, labels(n)[0] AS label,
       coalesce(n.difficulty, 'intermediate') AS difficulty, parent.name AS parentName
ORDER BY name ASC
LIMIT $limit;

// CAREER_DETAILS — One career with branches, required skills, related careers and projects.
MATCH (c:Career {id: $careerId})
OPTIONAL MATCH (c)-[:BELONGS_TO]->(b:EngineeringBranch)
WITH c, collect(DISTINCT b { .id, .name }) AS branches
OPTIONAL MATCH (c)-[rs:REQUIRES_SKILL]->(s:Skill)
WITH c, branches, collect(DISTINCT s { .id, .name, .summary, .difficulty, essential: rs.essential, weight: rs.weight }) AS skills
OPTIONAL MATCH (c)-[:RELATED_TO]-(other:Career)
WITH c, branches, skills, collect(DISTINCT other { .id, .name }) AS related
OPTIONAL MATCH (c)-[:SUGGESTS_PROJECT]->(p:Project)
WITH c, branches, skills, related, collect(DISTINCT p { .id, .name, .difficulty }) AS projects
RETURN c.id AS id, 'Career' AS label, c.name AS name, c.summary AS summary, c.description AS description,
       c.difficulty AS difficulty, c.verification AS verification, c.responsibilities AS responsibilities,
       c.portfolioIdeas AS portfolioIdeas, c.assumptions AS assumptions, c.typicalRoles AS typicalRoles,
       branches AS branches, skills AS skills, related AS related, projects AS projects
LIMIT 1;

// CAREER_BRANCHES — Engineering branch list with career counts.
MATCH (b:EngineeringBranch)
OPTIONAL MATCH (c:Career)-[:BELONGS_TO]->(b)
RETURN b.id AS id, 'EngineeringBranch' AS label, b.name AS name, b.summary AS summary,
       count(DISTINCT c) AS careerCount
ORDER BY b.name ASC
LIMIT $limit;

// CAREER_REQUIRED_SKILLS — Direct skills a career requires, with essential/weight flags.
MATCH (c:Career {id: $careerId})-[rs:REQUIRES_SKILL]->(s:Skill)
RETURN s.id AS id, 'Skill' AS label, s.name AS name, s.summary AS summary, s.difficulty AS difficulty,
       coalesce(rs.essential, true) AS essential, coalesce(rs.weight, 0.5) AS weight
ORDER BY essential DESC, difficulty ASC, name ASC
LIMIT $limit;

// SKILL_EDGES_BY_IDS — Prerequisite edges inside a bounded id set.
MATCH (a:Skill)-[r:REQUIRES]->(b:Skill)
WHERE a.id IN $ids AND b.id IN $ids
RETURN a.id AS from, b.id AS to, 'REQUIRES' AS type, coalesce(r.weight, r.strength, 1.0) AS weight, r.note AS note
LIMIT $limit;

// SKILL_DETAILS — One skill with prerequisites, unlocks, tools, projects and resources.
MATCH (s:Skill {id: $skillId})
OPTIONAL MATCH (s)-[r:REQUIRES]->(pre:Skill)
WITH s, collect(DISTINCT pre { .id, .name, strength: coalesce(r.weight, r.strength) }) AS prerequisites
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
       s.difficulty AS difficulty, s.estimatedHoursLow AS estimatedHoursLow, s.estimatedHoursHigh AS estimatedHoursHigh,
       s.completionCriteria AS completionCriteria, s.practice AS practice,
       prerequisites AS prerequisites, unlocks AS unlocks, tools AS tools, languages AS languages,
       projects AS projects, collect(DISTINCT res { .id, .name, .provider, .url, .accessModel, .format }) AS resources
LIMIT 1;

// PROJECT_CATALOG — Full project catalogue with optional difficulty filter.
MATCH (p:Project)
WHERE ($difficulty = '' OR p.difficulty = $difficulty)
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, collect(DISTINCT s.id) AS skillIds
ORDER BY p.name ASC
LIMIT $limit;

// PROJECTS_FOR_SKILLS — Projects that build a given set of skills, ranked by overlap.
MATCH (p:Project)-[:BUILDS_SKILL]->(s:Skill)
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
LIMIT $limit;

// PROJECTS_FOR_CAREER — Projects suggested by a career.
MATCH (c:Career {id: $careerId})-[:SUGGESTS_PROJECT]->(p:Project)
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, collect(DISTINCT s.id) AS skillIds
ORDER BY p.difficulty ASC, name ASC
LIMIT $limit;

// PROJECT_DETAILS — One project with objectives, milestones, safety notes and skills.
MATCH (p:Project {id: $projectId})
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
WITH p, collect(DISTINCT s { .id, .name }) AS skills
OPTIONAL MATCH (p)-[:USES]->(t)
RETURN p.id AS id, 'Project' AS label, p.name AS name, p.summary AS summary, p.description AS description,
       p.difficulty AS difficulty, p.objectives AS objectives, p.deliverables AS deliverables,
       p.milestones AS milestones, p.testingIdeas AS testingIdeas, p.extensions AS extensions,
       p.safetyNotes AS safetyNotes, p.estimatedHoursLow AS estimatedHoursLow, p.estimatedHoursHigh AS estimatedHoursHigh,
       p.tools AS tools, skills AS skills, collect(DISTINCT t { .id, .name }) AS toolNodes
LIMIT 1;

// RESOURCES_FOR_SKILLS — Resources covering a given set of skills.
MATCH (r:Resource)-[:COVERS]->(s:Skill)
WHERE s.id IN $skillIds
WITH r, collect(DISTINCT s.id) AS skillIds, count(DISTINCT s) AS matchCount
OPTIONAL MATCH (r)-[:COVERS]->(target)
OPTIONAL MATCH (r)-[:ASSUMES]->(presumed:Skill)
RETURN r.id AS id, 'Resource' AS label, r.name AS name, r.summary AS summary, r.url AS url,
       r.provider AS provider, r.format AS format, r.difficulty AS difficulty, r.language AS language,
       r.accessModel AS accessModel, r.accessNote AS accessNote, r.outcomes AS outcomes,
       r.assumes AS assumes, r.limits AS limits, r.commitment AS commitment,
       r.estimatedHoursLow AS estimatedHoursLow, r.estimatedHoursHigh AS estimatedHoursHigh,
       r.lastVerified AS lastVerified,
       r.verification AS verification, skillIds AS skillIds, matchCount AS matchCount,
       collect(DISTINCT target.id) AS coversIds,
       collect(DISTINCT target.name) AS coversNames,
       collect(DISTINCT presumed.id) AS assumesIds,
       collect(DISTINCT presumed.name) AS assumesNames
ORDER BY matchCount DESC, r.name ASC
LIMIT $limit;

// RESOURCES_FOR_SUBJECT — Resources covering a subject.
MATCH (r:Resource)-[:COVERS]->(covered)
WHERE covered.id = $subjectId OR EXISTS {
  MATCH (:Subject {id: $subjectId})-[:HAS_CONCEPT]->(c:Concept)
  WHERE c.id = covered.id
}
WITH DISTINCT r
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
ORDER BY r.name ASC
LIMIT $limit;

// RESOURCE_CATALOG — Searchable resource library with filters.
MATCH (r:Resource)
WHERE $q = '' OR toLower(r.name) CONTAINS $q OR toLower(coalesce(r.summary,'')) CONTAINS $q
   OR toLower(coalesce(r.provider,'')) CONTAINS $q OR toLower(coalesce(r.assumes,'')) CONTAINS $q
   OR toLower(coalesce(r.limits,'')) CONTAINS $q
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
SKIP $offset LIMIT $limit;

// RESOURCE_DETAILS — One resource with the entities it covers.
MATCH (r:Resource {id: $resourceId})
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
LIMIT 1;

// ROUTES_SKILL_TO_CAREER — Shortest routes from a known skill to a target career.
MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(target:Skill)
MATCH p = shortestPath((start:Skill {id: $fromSkillId})-[:REQUIRES*0..6]->(target))
WHERE length(p) >= 1
RETURN [n IN nodes(p) | n.id] AS ids,
       [n IN nodes(p) | n.name] AS names,
       [n IN nodes(p) | n.difficulty] AS difficulties,
       target.id AS targetId,
       target.name AS targetName,
       length(p) AS hops
ORDER BY hops ASC, targetName ASC
LIMIT $limit;

// CAREER_OVERVIEW_SUBGRAPH — Curated subgraph for the career overview graph view.
MATCH (c:Career {id: $careerId})-[:REQUIRES_SKILL]->(s:Skill)
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
WITH ([c] + skills + tools + projects + resources) AS base
UNWIND base AS n
RETURN DISTINCT 
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

LIMIT $limit;

// LABEL_COUNTS — Node counts per label.
MATCH (n)
UNWIND labels(n) AS label
RETURN label AS label, count(*) AS total
ORDER BY total DESC;

// SKILL_LOOKUP_BY_IDS — Skill metadata (effort ranges, criteria) for the roadmap engine.
MATCH (s:Skill)
WHERE s.id IN $ids
RETURN s.id AS id, 'Skill' AS label, s.name AS name, s.summary AS summary, s.difficulty AS difficulty,
       s.estimatedHoursLow AS estimatedHoursLow, s.estimatedHoursHigh AS estimatedHoursHigh,
       s.completionCriteria AS completionCriteria, s.practice AS practice
ORDER BY name ASC
LIMIT $limit;

// ASSESSMENTS_FOR_SKILLS — Short self-check questions attached to skills.
MATCH (a:Assessment)-[:ASSESSES]->(s:Skill)
WHERE s.id IN $ids
RETURN a.id AS id, 'Assessment' AS label, a.name AS name, a.summary AS summary, a.difficulty AS difficulty,
       a.questions AS questions, s.id AS skillId
ORDER BY name ASC
LIMIT $limit;

// MODULES_FOR_CAREER — Learning modules relevant to a career.
MATCH (m:LearningModule)-[:TEACHES]->(s:Skill)
WHERE ($careerId = '' OR EXISTS { MATCH (:Career {id: $careerId})-[:REQUIRES_SKILL]->(s) })
WITH m, count(DISTINCT s) AS overlap
OPTIONAL MATCH (m)-[:TEACHES]->(allSkill:Skill)
RETURN m.id AS id, 'LearningModule' AS label, m.name AS name, m.summary AS summary,
       collect(DISTINCT allSkill.id) AS skillIds
ORDER BY overlap DESC, name ASC
LIMIT $limit;

// ----------------------------------------------------------------------------
// Practical exploration recipes (not used by the app)
// ----------------------------------------------------------------------------

// Everything reachable from one career, 3 hops out
MATCH path = (c:Career {id: 'career:robotics-engineer'})-[*1..3]-(n)
RETURN path LIMIT 200;

// Longest prerequisite chain per career (which foundations bite hardest)
MATCH (c:Career)-[:REQUIRES_SKILL]->(s:Skill)
MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
WHERE NOT (base)-[:REQUIRES]->(:Skill)
RETURN c.name AS career, s.name AS skill, length(path) AS depth,
       [n IN nodes(path) | n.name] AS chain
ORDER BY depth DESC LIMIT 25;

// Skills a career needs that have no free resource attached
MATCH (c:Career {id: 'career:embedded-iot-engineer'})-[:REQUIRES_SKILL]->(s:Skill)
OPTIONAL MATCH (r:Resource)-[:TAUGHT_BY|COVERS]->(s)
WITH s, count(r) AS resources
WHERE resources = 0
RETURN s.id AS skill, s.name AS name ORDER BY name;

// Projects that teach the most skills inside one career
MATCH (c:Career)-[:SUGGESTS_PROJECT]->(p:Project)
OPTIONAL MATCH (p)-[:BUILDS_SKILL]->(s:Skill)
RETURN c.name AS career, p.name AS project, count(DISTINCT s) AS skills
ORDER BY skills DESC, project LIMIT 20;

// Resource coverage per access model (is the free path real?)
MATCH (r:Resource)
RETURN r.accessModel AS accessModel, count(*) AS resources,
       sum(CASE WHEN r.verification = 'verified' THEN 1 ELSE 0 END) AS verified
ORDER BY resources DESC;
