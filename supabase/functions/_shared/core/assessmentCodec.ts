/**
 * Assessment storage codec — the single source of truth for how a quiz question
 * is written into (and read back out of) Neo4j.
 *
 * Why encode at all: the AuraDB Free property model stores lists of primitives,
 * not lists of maps, so each question becomes one string:
 *
 *     prompt|option|option|#answerIndex
 *
 * The trailing answer token carries a leading '#' so it can never be confused
 * with a 0/1 index or with an option. A bare number is still accepted when
 * decoding, which keeps rows written by earlier emitters readable.
 *
 * Both the Cypher emitter (`scripts/emit-cypher.ts`) and every reader
 * (`neo4jReader.getAssessments`) call through this module, and
 * `scripts/validate-seed.ts` asserts a round-trip for the whole dataset — if the
 * two sides ever drift apart again, the self-check fails instead of silently
 * dropping every question.
 */
export interface EncodedQuestionShape {
  prompt: string
  options: string[]
  answerIndex: number
}

/** Separator between the prompt, each option and the answer token. */
export const ASSESSMENT_SEPARATOR = '|'
/** Prefix marking the final token as the answer index rather than an option. */
export const ASSESSMENT_ANSWER_PREFIX = '#'
/** Longest prompt the reader keeps. */
export const MAX_QUESTION_TEXT = 300
/** Longest option the reader keeps. */
export const MAX_OPTION_TEXT = 200
/** Most options a single question may carry. */
export const MAX_OPTIONS = 6
/** Fewest options a question may carry and still be answerable. */
export const MIN_OPTIONS = 2

/**
 * Encodes one question. Text containing the separator would corrupt the row, so
 * it is replaced here *and* rejected by the dataset validator; the replacement
 * is a safety net, not the contract.
 */
export function encodeAssessmentQuestion(question: EncodedQuestionShape): string {
  const clean = (value: string): string => value.replaceAll(ASSESSMENT_SEPARATOR, '/')
  return [
    clean(question.prompt),
    ...question.options.slice(0, MAX_OPTIONS).map(clean),
    `${ASSESSMENT_ANSWER_PREFIX}${question.answerIndex}`,
  ].join(ASSESSMENT_SEPARATOR)
}

export function encodeAssessmentQuestions(questions: readonly EncodedQuestionShape[]): string[] {
  return questions.map(encodeAssessmentQuestion)
}

/** Returns null for a row that cannot be decoded into a usable question. */
export function decodeAssessmentQuestion(encoded: string): EncodedQuestionShape | null {
  const parts = encoded.split(ASSESSMENT_SEPARATOR)
  if (parts.length < 3) return null
  const answerToken = parts[parts.length - 1].trim()
  const numeric = answerToken.startsWith(ASSESSMENT_ANSWER_PREFIX) ? answerToken.slice(ASSESSMENT_ANSWER_PREFIX.length) : answerToken
  const answerIndex = Number(numeric)
  const prompt = parts[0].trim()
  const options = parts.slice(1, -1).map((option) => option.trim()).slice(0, MAX_OPTIONS)
  // A question needs a prompt and at least two options to be answerable; the
  // dataset validator enforces the same range on the way in.
  if (prompt.length === 0 || options.length < MIN_OPTIONS || options.some((option) => option.length === 0)) return null
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) return null
  return { prompt: prompt.slice(0, MAX_QUESTION_TEXT), options, answerIndex }
}

export function decodeAssessmentQuestions(encoded: readonly string[]): EncodedQuestionShape[] {
  const out: EncodedQuestionShape[] = []
  for (const value of encoded) {
    const decoded = decodeAssessmentQuestion(value)
    if (decoded) out.push(decoded)
  }
  return out
}


