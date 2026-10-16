/**
 * Input validation contracts.
 *
 * Every external input (query string, path param, JSON body, search term) is
 * parsed by exactly one schema in this file before it touches repository code.
 * This is the single choke point that prevents:
 *   - injection (ids are pattern-locked, so nothing suspicious reaches Cypher),
 *   - oversized payloads (string and array caps everywhere),
 *   - parameter smuggling (`strictObject` rejects unknown keys),
 *   - ReDoS on search (length caps + no user-supplied patterns).
 */
import { z } from 'zod'

import { stripBidiAndFormat } from './security.ts'
import {
  DIFFICULTIES,
  MAX_CATALOG_LIMIT,
  NODE_LABELS,
  SKILL_STATES,
  RELATION_TYPES,
  MENTOR_INTENTS,
} from './types.ts'
import { validationError } from './errors.ts'

/* ==========================================================================
 * Identifiers
 * ========================================================================== */

/**
 * Ids are the only values interpolated into label names (never into data), and
 * even then only through a lookup table. The pattern is intentionally strict:
 *   career:software-engineer  | skill:python | project:line-follower-robot
 */
export const NODE_ID_PREFIXES = {
  career: 'Career',
  branch: 'EngineeringBranch',
  subject: 'Subject',
  concept: 'Concept',
  skill: 'Skill',
  lang: 'ProgrammingLanguage',
  tool: 'Tool',
  project: 'Project',
  resource: 'Resource',
  module: 'LearningModule',
  assessment: 'Assessment',
} as const

export type IdPrefix = keyof typeof NODE_ID_PREFIXES

export const NODE_ID_REGEX = /^(career|branch|subject|concept|skill|lang|tool|project|resource|module|assessment):[a-z0-9][a-z0-9-]{0,62}$/

export const nodeIdSchema = z
  .string()
  .min(4)
  .max(72)
  .regex(NODE_ID_REGEX, 'Identifiers look like "skill:python".')

export const careerIdSchema = z.string().max(72).regex(/^career:[a-z0-9][a-z0-9-]{0,62}$/, 'Expected a career id.')

export function idPrefixOf(id: string): IdPrefix | null {
  const prefix = id.split(':', 1)[0] as IdPrefix
  return prefix in NODE_ID_PREFIXES ? prefix : null
}

export function labelForId(id: string): (typeof NODE_LABELS)[number] | null {
  const prefix = idPrefixOf(id)
  if (!prefix) return null
  return NODE_ID_PREFIXES[prefix]
}

/** Rejects ids that do not belong to the expected label (authorisation of shape). */
export function assertIdLabel(id: string, expected: (typeof NODE_LABELS)[number]): boolean {
  return labelForId(id) === expected
}

/* ==========================================================================
 * Common scalars
 * ========================================================================== */

/**
 * Free text that will be stored or displayed.
 *
 * Two different treatments, on purpose:
 *   - **Control characters** (NUL, bell, escape…) are *rejected*. They are not
 *     something a learner types, so a refusal is more honest than a silent edit.
 *   - **Invisible and bidirectional formatting** (U+202A–U+202E, U+2066–U+2069,
 *     zero-width joiners, BOM) is *stripped*. These are the "clipboard attack"
 *     characters: they are invisible, they can reverse how a string renders, and
 *     a user pasting from a PDF or a slide has no way to know they are there.
 *     Refusing a paste because of characters the user cannot see is a bad form;
 *     removing them is the same protection without the surprise.
 *
 * This runs at the schema, so every route that accepts text gets it — before the
 * per-handler `sanitizeUntrustedText` pass, which stays as defence in depth.
 */
export const safeText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .transform((value) => stripBidiAndFormat(value))
    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), 'Contains control characters.')

export const searchTermSchema = z
  .string()
  .max(80, 'Search terms are limited to 80 characters.')
  .transform((v) => v.trim())

export const weeklyHoursSchema = z.number().int().min(1).max(60)
export const paceSchema = z.enum(['relaxed', 'steady', 'intensive'])
export const learningStyleSchema = z.enum(['video', 'reading', 'hands-on', 'mixed'])
export const difficultySchema = z.enum(DIFFICULTIES)
export const taskStatusSchema = z.enum(['not-started', 'in-progress', 'completed', 'needs-review'])
export const skillStateSchema = z.enum(SKILL_STATES)
export const listLimitSchema = z.number().int().min(1).max(50).default(12)

/* ==========================================================================
 * Read endpoints (GET)
 * ========================================================================== */

export const careerSearchQuerySchema = z.strictObject({
  q: searchTermSchema.optional(),
  branch: z.string().max(64).optional(),
  difficulty: difficultySchema.optional(),
  limit: listLimitSchema.optional(),
  offset: z.number().int().min(0).max(500).default(0).optional(),
})

export const skillIndexQuerySchema = z.strictObject({
  q: searchTermSchema.optional(),
  // The index is small (87 rows today: 60 skills + 27 concepts), but the cap is
  // explicit so a caller cannot ask for an unbounded response.
  limit: z.number().int().min(1).max(400).default(200).optional(),
})

export const careerDetailsQuerySchema = z.strictObject({
  careerId: careerIdSchema,
  includeGraph: z.boolean().default(true).optional(),
})

export const skillDetailsQuerySchema = z.strictObject({
  skillId: nodeIdSchema,
})

export const careerPathQuerySchema = z.strictObject({
  careerId: careerIdSchema,
  /** Optional starting point. Omit for "from the very beginning". */
  fromSkillId: nodeIdSchema.optional(),
  mode: z.enum(['prerequisites', 'route', 'downstream']).default('prerequisites').optional(),
  maxDepth: z.number().int().min(1).max(6).default(4).optional(),
})

export const neighborhoodQuerySchema = z.strictObject({
  /** Seed node. Omit to get a curated overview subgraph for a career. */
  seedId: nodeIdSchema.optional(),
  careerId: careerIdSchema.optional(),
  /** Restrict expansion to particular node labels (bounds payload size). */
  labels: z.array(z.enum(NODE_LABELS)).max(8).optional(),
  /** Relationship types to follow (defaults to all, minus noisy ones). */
  relations: z.array(z.enum(RELATION_TYPES)).max(16).optional(),
  depth: z.number().int().min(1).max(3).default(1).optional(),
  /** Hard row cap; the graph layer also clamps this internally. */
  limit: z.number().int().min(5).max(300).default(120).optional(),
  difficulty: difficultySchema.optional(),
})

export const resourcesQuerySchema = z.strictObject({
  q: searchTermSchema.optional(),
  skillId: nodeIdSchema.optional(),
  subjectId: nodeIdSchema.optional(),
  careerId: careerIdSchema.optional(),
  format: z.enum(['docs', 'video', 'course', 'book', 'tutorial', 'practice', 'repository', 'reference']).optional(),
  accessModel: z
    .enum(['free-open', 'free-account', 'free-audit', 'free-with-limits', 'mixed', 'unknown'])
    .optional(),
  difficulty: difficultySchema.optional(),
  limit: z.number().int().min(1).max(MAX_CATALOG_LIMIT).default(20).optional(),
})

export const projectsQuerySchema = z.strictObject({
  skillIds: z.array(nodeIdSchema).max(30).optional(),
  careerId: careerIdSchema.optional(),
  difficulty: difficultySchema.optional(),
  limit: z.number().int().min(1).max(MAX_CATALOG_LIMIT).default(8).optional(),
})

export const progressQuerySchema = z.strictObject({
  roadmapId: z.uuid().optional(),
})

/* ==========================================================================
 * Analysis endpoints (POST)
 * ========================================================================== */

export const skillRatingSchema = z.strictObject({
  skillId: nodeIdSchema,
  state: skillStateSchema,
  quizScore: z.number().min(0).max(1).optional(),
})

export const analyzeSkillGapsBodySchema = z.strictObject({
  careerId: careerIdSchema,
  ratings: z.array(skillRatingSchema).max(120).default([]),
  interests: z.array(z.string().max(48)).max(12).default([]),
  weeklyHours: weeklyHoursSchema.optional(),
  difficultyComfort: difficultySchema.optional(),
  /** Guests may ask for analysis without an account; the server still validates. */
  includeOptionalPaths: z.boolean().default(true).optional(),
})

export const generateRoadmapBodySchema = z.strictObject({
  careerId: careerIdSchema,
  ratings: z.array(skillRatingSchema).max(120).default([]),
  weeklyHours: weeklyHoursSchema.default(6),
  pace: paceSchema.default('steady'),
  learningStyle: learningStyleSchema.default('mixed'),
  difficultyComfort: difficultySchema.default('beginner'),
  interests: z.array(z.string().max(48)).max(12).default([]),
  /** ISO date (yyyy-mm-dd) the plan should start on. Optional. */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format yyyy-mm-dd.')
    .optional(),
  title: safeText(120).optional(),
})

const chatTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: safeText(1200, 1),
})

export const mentorChatBodySchema = z.strictObject({
  message: safeText(1200, 2),
  mode: z.enum(['concise', 'detailed']).default('concise'),
  careerId: careerIdSchema.nullish(),
  skillIds: z.array(nodeIdSchema).max(40).default([]),
  /** Only the last few turns are used; older context is discarded server-side. */
  history: z.array(chatTurnSchema).max(8).default([]),
  /** Hint for analytics-free routing; validated so it cannot be a free-form field. */
  intentHint: z.enum(MENTOR_INTENTS).optional(),
})

/* ==========================================================================
 * Write endpoints
 * ========================================================================== */

export const roadmapTaskSchema = z.strictObject({
  skillId: nodeIdSchema,
  name: safeText(120, 1),
  status: taskStatusSchema.default('not-started'),
  difficulty: difficultySchema.default('beginner'),
  /**
   * The client's stable identity for this row (see types.ts `taskKey`). Optional
   * because a roadmap built and saved by a different client may not have one;
   * the server then derives it from the order.
   */
  taskKey: safeText(80, 1).optional(),
  /** Learning row or spaced-review row; reviews reuse the skill they rehearse. */
  kind: z.enum(['learn', 'review']).optional(),
  order: z.number().int().min(0).max(200),
  scheduledWeek: z.number().int().min(1).max(104),
  scheduledDay: z.number().int().min(0).max(6).optional(),
  estimatedHoursLow: z.number().min(0).max(200),
  estimatedHoursHigh: z.number().min(0).max(400),
  essential: z.boolean().default(true),
  note: safeText(600).optional(),
})

export const saveRoadmapBodySchema = z.strictObject({
  /** Present when updating an existing roadmap the caller owns. */
  roadmapId: z.uuid().optional(),
  title: safeText(120, 1),
  careerId: careerIdSchema,
  weeklyHours: weeklyHoursSchema,
  pace: paceSchema,
  tasks: z.array(roadmapTaskSchema).min(1).max(120),
})

export const updateProgressBodySchema = z.strictObject({
  roadmapId: z.uuid(),
  taskId: z.uuid(),
  status: taskStatusSchema,
  note: safeText(600).optional(),
  actualHours: z.number().min(0).max(200).optional(),
})

export const resetProgressBodySchema = z.strictObject({
  roadmapId: z.uuid().optional(),
  /** Must be literally "RESET" — guards against an accidental destructive call. */
  confirm: z.literal('RESET'),
})

export const bookmarkBodySchema = z.strictObject({
  action: z.enum(['add', 'remove', 'list']),
  // Must match the `bookmarks.target_type` check constraint exactly (migration
  // 001) and the types the UI actually produces for graph nodes.
  targetType: z.enum(['skill', 'career', 'project', 'resource', 'module']).optional(),
  targetId: nodeIdSchema.optional(),
  note: safeText(400).optional(),
})

export const feedbackBodySchema = z.strictObject({
  kind: z.enum(['bug', 'content', 'resource-link', 'accessibility', 'other']),
  message: safeText(1500, 4),
  /** Optional contact address. Validated loosely; never used for marketing. */
  contact: z.string().max(160).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address.').optional(),
  targetId: nodeIdSchema.optional(),
  pageUrl: z.string().max(300).optional(),
})

/**
 * Pre-flight sign-in guard.
 *
 * `emailHash` is a client-computed SHA-256 prefix of the address, never the
 * address itself: the guard counts attempts per address without being able to
 * read the address. The strict object rejects every extra field, so this cannot
 * be turned into a smuggling route for other payloads.
 */
export const authGuardBodySchema = z.strictObject({
  emailHash: z.string().regex(/^[0-9a-f]{16,64}$/, 'Expected a hexadecimal email fingerprint.'),
  /**
   * How many UTF-8 bytes the password being tried is. The guard needs this to
   * refuse an oversized attempt *before* it reaches Supabase Auth's hashing — the
   * client sends a length, never the password. The upper bound is generous
   * (8 KiB) because it is an input sanity check here; the policy ceiling is
   * enforced against `PASSWORD_INPUT_CEILING_BYTES` in the handler.
   */
  passwordBytes: z.number().int().min(0).max(8192).optional(),
})

export const signatureHeaderSchema = z.strictObject({
  'x-gm-timestamp': z.string().regex(/^\d{10,14}$/),
  'x-gm-nonce': z.string().regex(/^[0-9a-f]{16,64}$/i),
  'x-gm-signature': z.string().regex(/^[0-9a-f]{64}$/i),
})

/* ==========================================================================
 * Helpers
 * ========================================================================== */

export interface ParseResult<T> {
  ok: boolean
  data?: T
  fields?: Record<string, string>
}

/** Flattens zod issues into a { field: message } map (values are never echoed). */
export function flattenIssues(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_'
    if (!fields[path]) fields[path] = issue.message
  }
  return fields
}

/** Throws an AppError(422) that the HTTP layer renders as field-level detail. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw validationError(flattenIssues(result.error))
  return result.data
}

export function tryParse<T>(schema: z.ZodType<T>, value: unknown): ParseResult<T> {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, fields: flattenIssues(result.error) }
}

/** Query-string helpers: every value is treated as untrusted text first. */
export function parseQuery(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, value] of params) {
    if (++count > 40) break // caps parameter-count abuse
    if (key.length > 40 || value.length > 500) continue
    out[key] = value
  }
  return out
}

/** Coerces "3" -> 3 and "true" -> true so query strings can feed the same schemas. */
export function coerceQuery(
  query: Record<string, string>,
  options: { numbers?: string[]; booleans?: string[]; lists?: string[] } = {},
): Record<string, unknown> {
  const { numbers = [], booleans = [], lists = [] } = options
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === '') continue
    if (lists.includes(key)) {
      const items = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 32)
      if (items.length > 0) out[key] = items
      continue
    }
    if (booleans.includes(key)) {
      out[key] = value === 'true' ? true : value === 'false' ? false : value
      continue
    }
    if (numbers.includes(key)) {
      const num = Number(value)
      out[key] = Number.isFinite(num) ? num : value
      continue
    }
    out[key] = value
  }
  return out
}

export const schemas = {
  careerSearchQuery: careerSearchQuerySchema,
  skillIndexQuery: skillIndexQuerySchema,
  careerDetailsQuery: careerDetailsQuerySchema,
  skillDetailsQuery: skillDetailsQuerySchema,
  careerPathQuery: careerPathQuerySchema,
  neighborhoodQuery: neighborhoodQuerySchema,
  resourcesQuery: resourcesQuerySchema,
  projectsQuery: projectsQuerySchema,
  analyzeSkillGaps: analyzeSkillGapsBodySchema,
  generateRoadmap: generateRoadmapBodySchema,
  mentorChat: mentorChatBodySchema,
  saveRoadmap: saveRoadmapBodySchema,
  updateProgress: updateProgressBodySchema,
  resetProgress: resetProgressBodySchema,
  bookmark: bookmarkBodySchema,
  feedback: feedbackBodySchema,
  authGuard: authGuardBodySchema,
}


