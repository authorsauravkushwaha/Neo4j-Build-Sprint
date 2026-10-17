// ===========================================================================
// GraphMentor AI — Judge Demo Cypher
//
// Run these in Neo4j Browser against the Aura instance (after seeding with
//   npm run seed:neo4j
// ). Every query here is a real parameterised query the backend executes
// (see supabase/functions/_shared/core/graphQuery.ts and
// server/neo4jDriverReader.ts). None of them accepts arbitrary user Cypher;
// the public /api/query endpoint only dispatches to named queries whose text
// lives in the repository.
// ===========================================================================

// 1. Graph statistics — what /api/graph/stats returns.
CALL db.labels() YIELD label
CALL { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS total }
RETURN label, total ORDER BY label ASC;

MATCH (n) RETURN count(n) AS nodes;
MATCH ()-[r]->() RETURN count(r) AS relationships;


// 2. Multi-hop career pathway — the signature GraphMentor question:
//    "What is the longest prerequisite chain I have to follow, starting from a
//     skill a Software Engineer role requires, down to the foundation skill?"
MATCH (c:Career {id: 'career:software-engineer'})-[:REQUIRES_SKILL]->(s:Skill)
MATCH path = (s)-[:REQUIRES*1..6]->(base:Skill)
WHERE NOT (base)-[:REQUIRES]->(:Skill)
RETURN c.name AS career,
       s.name AS requiredSkill,
       length(path) AS depth,
       [n IN nodes(path) | n.name] AS chain
ORDER BY depth DESC
LIMIT 10;


// 3. Personalised routes from a known skill to a required skill of a career —
//    this is what /gaps and /pathway surface when you rate yourself on skills.
MATCH (c:Career {id: 'career:software-engineer'})-[:REQUIRES_SKILL]->(target:Skill)
MATCH p = shortestPath((start:Skill {id: 'skill:programming-fundamentals'})-[:REQUIRES*0..6]->(target))
WHERE length(p) >= 1
RETURN [n IN nodes(p) | n.name] AS steps,
       target.name AS targetSkill,
       length(p) AS hops
ORDER BY hops ASC
LIMIT 10;


// 4. Evidence retrieval — which free resources cover the skills a career
//    requires (multi-hop: Career→Skill←Resource).
MATCH (c:Career {id: 'career:software-engineer'})-[:REQUIRES_SKILL]->(s:Skill)<-[:COVERS]-(r:Resource)
RETURN r.name AS resource,
       r.accessModel AS access,
       r.provider AS provider,
       collect(DISTINCT s.name) AS coveredSkills,
       count(DISTINCT s) AS covers
ORDER BY covers DESC, r.name ASC
LIMIT 15;


// 5. Graph exploration — subgraph for the visualisation (career overview).
MATCH (c:Career {id: 'career:software-engineer'})-[:REQUIRES_SKILL]->(s:Skill)
WITH c, collect(DISTINCT s) AS skills
UNWIND skills AS s
OPTIONAL MATCH (s)-[:USES]->(t)
OPTIONAL MATCH (s)-[:PRACTICED_BY]->(p:Project)
OPTIONAL MATCH (s)-[:TAUGHT_BY]->(r:Resource)
WITH c, skills,
     [x IN collect(DISTINCT t) WHERE x IS NOT NULL] AS tools,
     [x IN collect(DISTINCT p) WHERE x IS NOT NULL] AS projects,
     [x IN collect(DISTINCT r) WHERE x IS NOT NULL] AS resources
UNWIND (skills + tools + projects + resources) AS n
RETURN DISTINCT n.id AS id, head(labels(n)) AS label, n.name AS name
LIMIT 120;


// 6. Why Neo4j and not a JSON file? This multi-hop weighted traversal is the
//    backbone of the skill-gap / roadmap screens. It follows prerequisite
//    edges (REQUIRES), career requirements (REQUIRES_SKILL), coverage edges
//    (COVERS, TAUGHT_BY) and practice edges (BUILDS_SKILL, PRACTICED_BY) in
//    a single pattern — JSON code would re-implement BFS by hand.
MATCH (c:Career {id: 'career:robotics-engineer'})-[:REQUIRES_SKILL]->(target:Skill)
MATCH path = allShortestPaths((start:Skill {id: 'skill:programming-fundamentals'})-[:REQUIRES*0..6]->(target))
RETURN target.name AS targetSkill,
       [n IN nodes(path) | n.name] AS chain,
       length(path) AS hops
ORDER BY hops ASC
LIMIT 12;
