/**
 * POST /mentor-chat
 *
 * Pipeline: validate → rate limit → (optional) signed request → retrieve a
 * bounded graph slice → ask the AI provider (if configured) → validate the answer
 * against that slice → fall back to the deterministic engine on any failure.
 *
 * The AI never sees a query interface, never sees the user's identity, and never
 * writes to the knowledge graph.
 */
import { AppError, toAppError } from '../core/errors.ts'
import type { ApiRequest, HttpResponse } from '../core/http.ts'
import { json, parseJsonBody } from '../core/http.ts'
import { mentorChatBodySchema, parseOrThrow } from '../core/validate.ts'
import type { MentorChatResponse } from '../core/contracts.ts'
import {
  buildMentorContext,
  classifyIntent,
  createReadLedger,
  DEFAULT_CONTEXT_LIMITS,
  serializeContextForModel,
  serializeUserQuestion,
  totalReadMs,
  type MentorReadLedger,
  type MentorVocabularyEntry,
} from '../core/mentorContext.ts'
import { MENTOR_SYSTEM_PROMPT, composeMentorAnswer, trimToBudget } from '../core/mentorAnswer.ts'
import { answerWithRules } from '../core/fallbackMentor.ts'
import { sanitizeUntrustedText } from '../core/security.ts'
import type { Runtime } from '../runtime.ts'
import { enforceRateLimit, enforceSignedRequest, metaFor, requireReader } from './shared.ts'

/**
 * Bounded vocabulary used to resolve mentions without an extra graph query.
 *
 * Its two reads go into the same ledger as the context builder's, because they are
 * paid for by the same answer and an operator asking what that answer cost should
 * not have to know which module issued the query.
 */
async function loadVocabulary(
  runtime: Runtime,
  _request: ApiRequest,
  ledger: MentorReadLedger,
  signal?: AbortSignal,
): Promise<MentorVocabularyEntry[]> {
  const reader = runtime.reader
  if (!reader) return []
  const [careers, branches] = await Promise.all([reader.listCareers(60, { signal }), reader.listBranches(40, { signal })])
  ledger.record('listCareers', ['vocabulary'], careers, careers.value.length)
  ledger.record('listBranches', ['vocabulary'], branches, branches.value.length)
  const entries: MentorVocabularyEntry[] = [
    ...careers.value.map((career) => ({ id: career.id, name: career.name, label: 'Career' as const })),
    ...branches.value.map((branch) => ({ id: branch.id, name: branch.name, label: 'EngineeringBranch' as const })),
  ]
  return entries
}

export async function mentorChatHandler(runtime: Runtime, request: ApiRequest): Promise<HttpResponse> {
  const reader = requireReader(runtime, request)

  // Two windows: a burst limit per minute and a ceiling per hour, so a learner
  // cannot exhaust a free AI tier in one sitting.
  const minute = await enforceRateLimit(runtime, request, runtime.config.limits.mentorPerMinute, 'mentor-minute')
  await enforceRateLimit(runtime, request, runtime.config.limits.mentorPerHour, 'mentor-hour')
  await enforceSignedRequest(runtime, request)

  const input = parseOrThrow(mentorChatBodySchema, parseJsonBody(request))
  const question = serializeUserQuestion(input.message)

  if (question.suspicious.length > 0) {
    request.logger.warn('instruction-like text in mentor question was neutralised', {
      matches: question.suspicious.length,
    })
  }

  const intent = input.intentHint ?? classifyIntent(question.text)
  const ledger = createReadLedger()
  const vocabulary = await loadVocabulary(runtime, request, ledger)

  const context = await buildMentorContext({
    reader,
    message: question.text,
    intent,
    careerId: input.careerId ?? null,
    knownSkillIds: input.skillIds,
    vocabulary,
    limits: { ...DEFAULT_CONTEXT_LIMITS, maxChars: runtime.config.limits.maxContextChars },
    ledger,
  })

  let modelText: string | null = null
  let degradedReason: string | undefined

  if (runtime.ai.configured) {
    const contextBlock = trimToBudget(serializeContextForModel(context), runtime.config.limits.maxContextChars)
    const userPrompt = [
      `Learner question (${input.mode} mode): ${question.text}`,
      '',
      contextBlock,
      '',
      'Answer using only the CONTEXT above plus general engineering knowledge that you clearly label as general.',
    ].join('\n')

    try {
      const completion = await runtime.ai.complete({
        system: MENTOR_SYSTEM_PROMPT,
        user: userPrompt,
      })
      modelText = completion.text
    } catch (error) {
      const appError = toAppError(error)
      degradedReason =
        appError.code === 'rate_limited'
          ? 'The AI provider is rate limiting this deployment right now.'
          : appError.code === 'timeout'
            ? 'The AI provider did not answer in time.'
            : 'The AI provider is unavailable right now.'
      request.logger.warn('mentor ai call failed, using rules engine', { code: appError.code })
    }
  }

  const answer = modelText
    ? composeMentorAnswer({ request: input, context, modelText, ...(degradedReason ? { degradedReason } : {}) })
    : answerWithRules({ request: input, context, ...(degradedReason ? { degradedReason } : {}) })

  // Safety net: never return an empty answer.
  if (!answer.answer || answer.answer.trim().length === 0) {
    throw new AppError('internal', {
      requestId: request.requestId,
      publicMessage: 'The mentor could not produce an answer for that question. Try rephrasing it with a skill or career name.',
    })
  }

  const payload: MentorChatResponse = {
    answer: {
      ...answer,
      answer: sanitizeUntrustedText(answer.answer, input.mode === 'detailed' ? 4000 : 2200),
    },
    context: {
      intent,
      skillsUsed: context.skills.length,
      projectsUsed: context.projects.length,
      resourcesUsed: context.resources.length,
      truncated: context.truncated,
      graphSource: reader.kind === 'neo4j' ? 'neo4j-live' : 'local-sample',
      reads: context.reads,
      readMs: totalReadMs(context.reads),
    },
    limits: {
      requestsRemainingThisMinute: minute.remaining,
      maxMessageChars: 1200,
    },
  }

  return json(
    200,
    { ok: true, data: payload, meta: metaFor(reader, { truncated: context.truncated }) },
    {
      'cache-control': 'no-store',
      'x-ratelimit-remaining': String(minute.remaining),
      'x-ratelimit-reset': String(minute.resetSeconds),
    },
  )
}


