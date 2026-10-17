# Neo4j schema for user data

GraphMentor AI stores its **curriculum** and its **user data** in one Neo4j AuraDB database.
Supabase is used for **sign-in only** (verifying the bearer token with Supabase Auth). Nothing
else is read from or written to Supabase.

| Concern | Where it lives |
| --- | --- |
| Curriculum (careers, skills, resources, …) | `neo4j/schema.cypher` + `neo4j/seed.cypher` (generated) |
| Accounts, roadmaps, progress, bookmarks, feedback, profiles, rate limits, nonces | `neo4j/user-schema.cypher` (this document) |
| Sign-in, token verification | Supabase Auth (`createAuthVerifier`) |

The old Postgres tables (`supabase/migrations/001_*.sql`, `002_*.sql`) are kept as history. They are not
applied by the Supabase deployment path any more.

## Applying the schema

```bash
npm run seed:neo4j -- --dry-run     # lists the schema and seed statements; writes nothing
npm run seed:neo4j                  # applies neo4j/schema.cypher, then neo4j/user-schema.cypher, then the seed
```

Every statement is idempotent (`IF NOT EXISTS`, `MERGE`). Apply the schema to a fresh database before
the app serves user data. The store relies on the uniqueness constraints below for `MERGE` to be
race-safe.

Neo4j Browser or cypher-shell can also run `neo4j/user-schema.cypher` directly.

## Model

```
(:AppUser {id, educationLevel, branch, careerGoalId, interests, weeklyHours, preferredPace,
           learningStyle, goalNote, theme, reducedMotion, createdAt, updatedAt})
   │
   ├─[:OWNS]──────────▶ (:Roadmap {id, userId, title, careerId, careerName, weeklyHours, pace,
   │                                estimateDisclaimer, milestonesJson, createdAt, updatedAt})
   │                        │
   │                        └─[:HAS_TASK]──▶ (:RoadmapTask {id, key, userId, roadmapId, skillId, name,
   │                                                       status, difficulty, orderIndex, scheduledWeek,
   │                                                       scheduledDay, estimatedHoursLow, estimatedHoursHigh,
   │                                                       essential, note, actualHours, createdAt, updatedAt})
   │
   ├─[:HAS_RATING]───▶ (:SkillRating {id, key, userId, skillId, state, quizScore, createdAt, updatedAt})
   │                        │
   │                        └─[:RATES]──▶ (:Skill)           (existing curriculum node, when it exists)
   │
   └─[:SAVED]────────▶ (:Bookmark {id, key, userId, targetType, targetId, note, createdAt})

(:Feedback {id, userId | null, kind, message, contact, targetId, pageUrl, createdAt})   (no relationships)
(:RateLimitBucket {id, count, expiresAt, createdAt})                                    (one per key per window)
(:UsedNonce {nonce, expiresAt, replays, createdAt})                                    (replay ledger)
```

Relationships are created only when both endpoints exist. Feedback is linked by its `userId`
property, not by a relationship, so anonymous feedback needs no account node.

### Keys and constraints

| Label | Unique constraint | Purpose |
| --- | --- | --- |
| `AppUser` | `id` | One node per account. Also holds the profile preferences. |
| `Roadmap` | `id` | Server-generated UUID. A client id is reused only if it already belongs to the caller. |
| `RoadmapTask` | `id`, `key` | `key = roadmapId\|orderIndex\|skillId`. Re-saving a roadmap updates tasks in place. |
| `SkillRating` | `id`, `key` | `key = userId\|skillId`. One rating per user per skill. |
| `Bookmark` | `id`, `key` | `key = userId\|targetId`. One bookmark per user per target. |
| `Feedback` | `id` | Server-generated UUID. |
| `RateLimitBucket` | `id` | `id = key\|windowSeconds\|windowStart`. Epoch-anchored fixed windows. |
| `UsedNonce` | `nonce` | Replay ledger. `replays` counts repeats of the same nonce. |

Lookup indexes (range indexes): `Roadmap.userId`, `Roadmap.updatedAt`, `RoadmapTask.roadmapId`,
`RoadmapTask.userId`, `SkillRating.userId`, `Bookmark.userId`, `Feedback.userId`,
`RateLimitBucket.expiresAt`, `UsedNonce.expiresAt`.

## Property mapping to the API

The store (`supabase/functions/_shared/platform/neo4jStore.ts`) maps Neo4j properties to the
snake_case row shapes the handlers already use, so the HTTP API and the frontend do not change.

| API field | Neo4j property |
| --- | --- |
| `saved_roadmaps.milestones` | `Roadmap.milestonesJson` (JSON string; Neo4j cannot store nested maps) |
| `roadmap_tasks.order_index` | `RoadmapTask.orderIndex` |
| `roadmap_tasks.estimated_hours_low/high` | `RoadmapTask.estimatedHoursLow/High` |
| `user_skill_progress.quiz_score` | `SkillRating.quizScore` |
| `bookmarks.target_type/target_id` | `Bookmark.targetType/targetId` |
| `profiles.education_level` … `reduced_motion` | `AppUser.educationLevel` … `reducedMotion` |

## Access rules

- **Every query is scoped by the verified account.** Queries start from `(:AppUser {id: $userId})` or
  match nodes whose `userId` equals `$userId`. Ownership is checked before a client-supplied id is used.
- **Values are parameters.** Cypher text is a fixed constant in `neo4jStore.ts`. User input never
  reaches the query text.
- **No cross-account overwrite.** A `Roadmap` id from a client is reused only when that roadmap already
  belongs to the caller. Otherwise the server generates a new id.
- **Writes are retried only when rolled back.** Transient errors and `MERGE` constraint races are
  retried, because Neo4j rolls those transactions back. Timeouts and dropped connections are not
  retried for writes, since the write may have committed.
- **Replay protection fails closed.** If the replay ledger cannot be reached, the signed request is
  refused.

## Data rights

- **Export** returns the account's profile, roadmaps, tasks, skill ratings, bookmarks and feedback
  (feedback is matched by `userId`).
- **Delete account data** removes roadmaps, tasks, skill ratings, bookmarks and the profile. It keeps
  anonymous product feedback, and it does not delete the Supabase sign-in account.

## Retention

- `RateLimitBucket` and `UsedNonce` nodes are pruned by the store's `cleanup()` once `expiresAt` has
  passed. Pruning runs in bounded batches.
- Feedback is kept until it is deleted by an operator.

## Verification

- `tests/unit/neo4j-schema-consistency.test.ts` checks that every label, property and relationship
  the store writes is declared in `user-schema.cypher`, and that the schema statements parse.
- `tests/unit/neo4j-store.test.ts` runs the repositories and stores against a mock runner, and checks
  the parameter contract: no user value is interpolated into Cypher, and every query takes `$userId`.
- These tests run against a mock. They do not prove connectivity to AuraDB. Connectivity needs a live
  run of `npm run seed:neo4j -- --check` against the instance.
