// ============================================================================
// GraphMentor AI — Neo4j schema (constraints + indexes)
//
// GENERATED FILE — do not edit by hand.
// Source: src/data/seed/knowledgeGraph.ts
// Regenerate: npm run emit:cypher
// Idempotent: safe to run on an existing database.
// Requires Neo4j 5.x (AuraDB Free qualifies).
// 
// Neo4j Community/Aura supports uniqueness constraints and range indexes
// only; no full-text or vector indexes are used, so the free tier is enough.
// ============================================================================

// One uniqueness constraint per label guarantees MERGE is idempotent and
// makes every id lookup an index seek.
CREATE CONSTRAINT gm_career_id IF NOT EXISTS FOR (n:Career) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_engineeringbranch_id IF NOT EXISTS FOR (n:EngineeringBranch) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_subject_id IF NOT EXISTS FOR (n:Subject) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_concept_id IF NOT EXISTS FOR (n:Concept) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_skill_id IF NOT EXISTS FOR (n:Skill) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_programminglanguage_id IF NOT EXISTS FOR (n:ProgrammingLanguage) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_tool_id IF NOT EXISTS FOR (n:Tool) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_project_id IF NOT EXISTS FOR (n:Project) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_resource_id IF NOT EXISTS FOR (n:Resource) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_assessment_id IF NOT EXISTS FOR (n:Assessment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT gm_learningmodule_id IF NOT EXISTS FOR (n:LearningModule) REQUIRE n.id IS UNIQUE;

// Range indexes used by search and by the resource catalogue filters.
CREATE INDEX gm_career_name IF NOT EXISTS FOR (n:Career) ON (n.name);
CREATE INDEX gm_skill_name IF NOT EXISTS FOR (n:Skill) ON (n.name);
CREATE INDEX gm_skill_difficulty IF NOT EXISTS FOR (n:Skill) ON (n.difficulty);
CREATE INDEX gm_resource_access IF NOT EXISTS FOR (n:Resource) ON (n.accessModel);
CREATE INDEX gm_project_difficulty IF NOT EXISTS FOR (n:Project) ON (n.difficulty);
CREATE INDEX gm_subject_name IF NOT EXISTS FOR (n:Subject) ON (n.name);

// Relationship property index: the roadmap engine sorts by weight.
CREATE INDEX gm_requires_skill_weight IF NOT EXISTS FOR ()-[r:REQUIRES_SKILL]-() ON (r.weight);

// What the app expects to find, for a quick sanity check after seeding:
//   MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes ORDER BY label;
//   MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS rels ORDER BY rel;
