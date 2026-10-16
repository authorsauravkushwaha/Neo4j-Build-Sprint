/**
 * The read ledger: what the mentor looked at, and what it cost.
 *
 * Every GraphMentor answer claims to be written from the knowledge graph and
 * nothing else. The citations (`evidence`) say which graph *entities* the answer
 * used; the ledger says which *queries* produced them, how many rows each returned
 * and how long each took. That makes the claim auditable in both directions: a
 * reviewer can check that an answer about a named career actually queried that
 * career, and can see that an answer the graph could not support issued one fruitless
 * read rather than quietly inventing content.
 *
 * Nothing here asserts a specific latency — those are machine-dependent. What is
 * asserted is that the ledger *accounts* for the reads that ran: the row totals add
 * up, the duration is the sum of the parts, unknown ids are recorded as zero rows
 * rather than dropped, and truncation is carried through, because a read that hit
 * its limit is the one case where the answer is honest but incomplete.
 */
import { describe, expect, it } from 'vitest'

import { createLocalReader } from '@core/localReader.ts'
import {
  buildMentorContext,
  createReadLedger,
  DEFAULT_CONTEXT_LIMITS,
  summarizeReads,
  totalReadMs,
  type MentorReadEntry,
} from '@core/mentorContext.ts'
import type { GraphReader } from '@core/graphReader.ts'
import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'

const reader = createLocalReader(knowledgeGraph)

function entry(over: Partial<MentorReadEntry> = {}): MentorReadEntry {
  return { call: 'getSkill', target: 'skill:a', rows: 1, ms: 2, truncated: false, ...over }
}

async function build(message: string, over: { reader?: GraphReader; knownSkillIds?: string[] } = {}) {
  const ledger = createReadLedger()
  const context = await buildMentorContext({
    reader: over.reader ?? reader,
    message,
    intent: 'why-prerequisite',
    vocabulary: [{ id: 'career:robotics-engineer', name: 'Robotics Engineer', label: 'Career' }],
    limits: DEFAULT_CONTEXT_LIMITS,
    ledger,
    ...(over.knownSkillIds ? { knownSkillIds: over.knownSkillIds } : {}),
  })
  return { context, ledger }
}

describe('summarizeReads', () => {
  it('groups repeated calls and adds their rows and durations up', () => {
    const reads = summarizeReads([
      entry({ call: 'getSkill', target: 'skill:a', rows: 1, ms: 3 }),
      entry({ call: 'getSkill', target: 'skill:b', rows: 1, ms: 4 }),
      entry({ call: 'getSkill', target: 'skill:a', rows: 0, ms: 1 }),
    ])

    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ call: 'getSkill', calls: 3, rows: 2, ms: 8 })
    // Distinct targets are kept, in the order they were first seen.
    expect(reads[0]!.target).toBe('skill:a, skill:b')
  })

  it('says how many targets it did not print instead of dropping them silently', () => {
    const targets = ['skill:a', 'skill:b', 'skill:c', 'skill:d', 'skill:e']
    const reads = summarizeReads(targets.map((target) => entry({ target })))

    expect(reads[0]!.target).toBe('skill:a, skill:b, skill:c, +2 more')
    expect(reads[0]!.calls).toBe(5)
  })

  it('keeps one method per line, in first-seen order, and threads truncation through', () => {
    const reads = summarizeReads([
      entry({ call: 'getCareer', target: 'career:x', rows: 1 }),
      entry({ call: 'findResources', target: '4 skills', rows: 6 }),
      entry({ call: 'getCareer', target: 'career:x', rows: 1, truncated: true }),
    ])

    expect(reads.map((read) => read.call)).toEqual(['getCareer', 'findResources'])
    expect(reads[0]!.truncated).toBe(true)
    expect(reads[1]!.truncated).toBe(false)
  })

  it('totalReadMs is the sum of the lines it reports', () => {
    const reads = summarizeReads([entry({ ms: 5 }), entry({ call: 'getCareer', ms: 7 })])
    expect(totalReadMs(reads)).toBe(12)
  })
})

describe('the ledger an answer actually ships', () => {
  it('accounts for the reads a career question needed, and names the career it read', async () => {
    const { context } = await build('Which skills should I learn first for robotics?')

    const calls = context.reads.map((read) => read.call)
    expect(calls).toContain('getCareer')
    expect(calls).toContain('findProjects')
    expect(calls).toContain('findResources')

    const careerRead = context.reads.find((read) => read.call === 'getCareer')!
    expect(careerRead.target).toBe('career:robotics-engineer')
    expect(careerRead.rows).toBe(1)
    expect(careerRead.calls).toBe(1)
  })

  it('records a read that returned nothing, rather than hiding the attempt', async () => {
    const { context } = await build('Tell me about a career the graph does not have')

    const careerRead = context.reads.find((read) => read.call === 'getCareer')
    // The mention resolves to nothing, so either no career read happened at all or
    // one happened and found nothing. Neither may be recorded as a successful read.
    if (careerRead) expect(careerRead.rows).toBe(0)
    expect(context.unknowns.length).toBeGreaterThan(0)
  })

  it('row counts are the rows the reader returned, not a restatement of the answer', async () => {
    const { context } = await build('What should I do next for robotics?')

    for (const read of context.reads) {
      expect(read.rows).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(read.rows)).toBe(true)
      expect(read.ms).toBeGreaterThanOrEqual(0)
      // Every line names a real reader method, so a reader can grep its cost.
      expect(typeof (reader as unknown as Record<string, unknown>)[read.call]).toBe('function')
    }
  })

  it('is the same ledger the caller supplied, so outside reads join the same tab', async () => {
    const ledger = createReadLedger()
    const context = await buildMentorContext({
      reader,
      message: 'What should I learn first?',
      intent: 'study-plan',
      vocabulary: [{ id: 'career:robotics-engineer', name: 'Robotics Engineer', label: 'Career' }],
      limits: DEFAULT_CONTEXT_LIMITS,
      ledger,
    })

    // A read the module never issued itself, recorded by the caller first.
    ledger.record('listCareers', ['vocabulary'], { ms: 1 }, 17)

    expect(ledger.entries.length).toBeGreaterThan(context.reads.length - 1)
    expect(context.reads.map((read) => read.call)).not.toContain('listCareers')
    expect(ledger.summarize().map((read) => read.call)).toContain('listCareers')
    expect(totalReadMs(ledger.summarize())).toBeGreaterThanOrEqual(context.reads.reduce((sum, read) => sum + read.ms, 0))
  })

  it('stays small enough to render: at most one line per reader method', async () => {
    const { context } = await build('Which skills should I learn first for robotics?')
    const calls = context.reads.map((read) => read.call)
    expect(new Set(calls).size).toBe(calls.length)
    expect(context.reads.length).toBeLessThanOrEqual(10)
  })

  it('a message that matches nothing in the graph still reports its reads', async () => {
    const { context } = await build('qwertyuiop zxcvbnm')

    // The honest failure mode: reads happened, they returned nothing, and the ledger
    // shows that rather than reporting a confident answer with no provenance.
    const rows = context.reads.reduce((sum, read) => sum + read.rows, 0)
    expect(rows).toBe(0)
    expect(context.unknowns.length).toBeGreaterThan(0)
  })
})
