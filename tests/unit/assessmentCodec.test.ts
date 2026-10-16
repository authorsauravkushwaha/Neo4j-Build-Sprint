/**
 * Regression guard for the assessment storage encoding.
 *
 * This is the bug the dataset self-check used to miss: the Cypher emitter wrote
 * "prompt|option|option|#N" while the reader parsed `Number(lastToken)`, so every
 * question decoded to NaN and was silently dropped — the app would have shipped
 * an empty quiz against a live graph. Both sides now share this codec, and these
 * tests pin the wire format so a future "tidy-up" of either side fails loudly.
 */
import { describe, expect, it } from 'vitest'

import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import {
  ASSESSMENT_ANSWER_PREFIX,
  ASSESSMENT_SEPARATOR,
  decodeAssessmentQuestion,
  decodeAssessmentQuestions,
  encodeAssessmentQuestion,
  encodeAssessmentQuestions,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
} from '@core/assessmentCodec.ts'

describe('encoding', () => {
  it('writes prompt, options and a marked answer index', () => {
    const encoded = encodeAssessmentQuestion({ prompt: 'Which unit measures power?', options: ['Watt', 'Joule', 'Newton'], answerIndex: 0 })
    expect(encoded.split(ASSESSMENT_SEPARATOR)).toEqual(['Which unit measures power?', 'Watt', 'Joule', 'Newton', `${ASSESSMENT_ANSWER_PREFIX}0`])
  })

  it('marks the answer so an option can never be mistaken for it', () => {
    const encoded = encodeAssessmentQuestion({ prompt: 'Pick', options: ['0', '1', '2'], answerIndex: 2 })
    // A bare answer index of 2 would be indistinguishable from the option "2".
    expect(encoded.endsWith('|#2')).toBe(true)
    const decoded = decodeAssessmentQuestion(encoded)!
    expect(decoded.answerIndex).toBe(2)
    expect(decoded.options).toEqual(['0', '1', '2'])
  })

  it('replaces a separator inside the text rather than corrupting the row', () => {
    const encoded = encodeAssessmentQuestion({ prompt: 'a|b', options: ['c|d', 'e'], answerIndex: 1 })
    expect(encoded.split(ASSESSMENT_SEPARATOR)).toHaveLength(4)
    expect(decodeAssessmentQuestion(encoded)!.options).toEqual(['c/d', 'e'])
  })

  it('caps the number of options', () => {
    const many = Array.from({ length: 9 }, (_, index) => `option ${index}`)
    const encoded = encodeAssessmentQuestion({ prompt: 'p', options: many, answerIndex: 3 })
    expect(encoded.split(ASSESSMENT_SEPARATOR)).toHaveLength(2 + MAX_OPTIONS)
  })
})

describe('decoding', () => {
  it('round-trips every question in the real dataset', () => {
    let questions = 0
    for (const assessment of knowledgeGraph.assessments) {
      const decoded = decodeAssessmentQuestions(encodeAssessmentQuestions(assessment.questions))
      expect(decoded).toHaveLength(assessment.questions.length)
      expect(decoded).toEqual(assessment.questions)
      questions += decoded.length
    }
    // The dataset ships 32 authored questions; a silent drop is a test failure.
    expect(questions).toBeGreaterThanOrEqual(30)
  })

  it('still accepts a bare numeric answer index from older rows', () => {
    const decoded = decodeAssessmentQuestion('Older row|yes|no|1')
    expect(decoded).toEqual({ prompt: 'Older row', options: ['yes', 'no'], answerIndex: 1 })
  })

  it('drops malformed rows instead of guessing', () => {
    const bad = [
      'no separators at all',
      'prompt|only-one-option|#0', // fewer than two options
      'prompt|a|b|#9', // index out of range
      'prompt|a|b|#x', // not a number
      '|a|b|#0', // missing prompt
      'prompt|a||#1', // empty option
    ]
    for (const row of bad) expect(decodeAssessmentQuestion(row), row).toBeNull()
    expect(decodeAssessmentQuestions(bad)).toEqual([])
  })

  it('keeps a valid row when it sits beside a broken one', () => {
    const decoded = decodeAssessmentQuestions(['broken', 'Good prompt|x|y|#1', 'also broken'])
    expect(decoded).toHaveLength(1)
    expect(decoded[0].prompt).toBe('Good prompt')
  })

  it('trims and length-limits, as the storage property is capped', () => {
    const decoded = decodeAssessmentQuestion(`  ${'P'.repeat(500)}  |  a  |  b  |#0`)!
    expect(decoded.prompt.length).toBe(MAX_QUESTION_TEXT)
    expect(decoded.options).toEqual(['a', 'b'])
  })

  it('never mistakes a leading # for an option', () => {
    expect(decodeAssessmentQuestion('p|#tag|other|#0')!.options).toEqual(['#tag', 'other'])
  })
})


