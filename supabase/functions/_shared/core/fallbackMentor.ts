/**
 * Deterministic mentor ("rules" provider).
 *
 * This is not a stub: it answers every supported intent using the same graph
 * context the AI would receive, and it is what makes the product fully usable
 * with no AI key configured. Questions it cannot ground in the graph are
 * answered with an explicit "the graph does not cover this" message instead of
 * invented content.
 */
import type { MentorAnswer, MentorRequest } from './types.ts'
import type { MentorContext } from './mentorContext.ts'
import { CAVEATS, dependentCount, taskStatusLabel } from './recommend.ts'

const DISCLAIMER =
  'Graph-grounded answer from the recommendation engine, not from a language model. Verify anything that matters against the linked resources.'

function bullets(items: string[], max = 6): string {
  return items
    .slice(0, max)
    .map((item) => `- ${item}`)
    .join('\n')
}

function nameOf(context: MentorContext, id: string): string {
  return context.skills.find((s) => s.id === id)?.name ?? id
}

function essentialSkills(context: MentorContext) {
  return context.skills.filter((s) => s.essential)
}

function detailsSuffix(mode: MentorRequest['mode']): string {
  return mode === 'detailed'
    ? '\n\nIf you want the deeper reasoning, open the Knowledge Graph for this skill: every statement above maps to a labelled relationship you can inspect.'
    : ''
}

interface FallbackOptions {
  request: MentorRequest
  context: MentorContext
  /** True when an AI provider was configured but failed. */
  degradedReason?: string
}

export function answerWithRules(options: FallbackOptions): MentorAnswer {
  const { request, context } = options
  const mode = request.mode
  const intent = context.intent
  const careerName = context.career?.name ?? 'your target career'

  let answer = ''
  const nextActions: string[] = []

  switch (intent) {
    case 'why-prerequisite': {
      const target =
        context.skills.find((skill) => skill.prerequisites.length > 0 && context.mentions.skills.includes(skill.id)) ??
        context.skills.find((skill) => skill.prerequisites.length > 0)
      if (target) {
        const prereqNames = target.prerequisites.map((id) => nameOf(context, id))
        const dependents = dependentCount(target.id, {
          prerequisites: new Map(context.skills.map((s) => [s.id, s.prerequisites])),
          dependents: new Map(context.skills.map((s) => [s.id, s.unlocks])),
          cyclic: [],
        })
        answer = [
          `**Why ${prereqNames[0]} comes before ${target.name}**`,
          '',
          `In the graph, \`${target.id}\` declares \`REQUIRES\` relationships to: ${prereqNames.join(', ')}. That means the curriculum treats them as things you should be comfortable with *before* ${target.name}, not afterwards.`,
          '',
          `Practical reason: ${target.name} reuses the vocabulary and mental models from ${prereqNames[0]}. Skipping it usually shows up as "I can follow the tutorial but cannot debug my own version" — you are copying steps without being able to reason about what should happen.`,
          '',
          dependents > 0
            ? `Learning ${target.name} then unlocks ${dependents} further skill(s) in this route.`
            : 'It is a leaf skill in the current graph slice — nothing else depends on it here.',
        ].join('\n')
        nextActions.push(
          `Open ${prereqNames[0]} in the Knowledge Graph and read its completion criteria.`,
          `Do one short exercise using ${prereqNames[0]} on its own before returning to ${target.name}.`,
        )
      } else {
        answer = `I could not find a skill in the graph that matches this question closely enough to explain a prerequisite chain. Try naming the skill directly, for example "Why do I need mechanics before robotics?", or pick the career first in Explore Careers and ask again.`
        nextActions.push('Open Explore Careers and choose a target career so the mentor has a graph context.')
      }
      break
    }

    case 'skill-gap': {
      const essential = essentialSkills(context)
      const known = essential.filter((skill) => skill.masteryState && skill.masteryState !== 'unknown')
      const missing = essential.filter((skill) => !skill.masteryState || skill.masteryState === 'unknown')
      answer = [
        `**Skill picture for ${careerName}**`,
        '',
        context.career
          ? `The graph lists ${context.skills.length} skill(s) for this career, ${essential.length} of them marked essential.`
          : `The graph slice for this question contains ${context.skills.length} skill(s).`,
        '',
        known.length > 0
          ? `You reported knowing: ${known.map((s) => s.name).join(', ')}.`
          : 'You have not told me which of these you already know, so I am treating them all as candidates.',
        missing.length > 0 ? `Still open: ${missing.slice(0, 8).map((s) => s.name).join(', ')}.` : '',
        '',
        'These come from your own self-assessment, which is a planning aid — not a verified measure of ability.',
      ]
        .filter(Boolean)
        .join('\n')
      nextActions.push(
        'Open Skill Gap Analyzer to mark what you already know, so the roadmap stops scheduling it.',
        'Start with the prerequisite-most skill among the open items; it is usually the one everything else waits on.',
      )
      break
    }

    case 'project-idea': {
      if (context.projects.length > 0) {
        const project = context.projects[0]
        answer = [
          `**Suggested project: ${project.name}** (${project.difficulty})`,
          '',
          project.summary,
          '',
          `It builds: ${project.skills.map((id) => nameOf(context, id)).slice(0, 6).join(', ') || 'the skills currently in your route'}.`,
          '',
          context.projects.length > 1
            ? `Alternatives from the graph: ${context.projects.slice(1, 4).map((p) => `${p.name} (${p.difficulty})`).join('; ')}.`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
        nextActions.push(
          `Open the Projects screen and check the deliverables and testing ideas for ${project.name}.`,
          'Pick the smallest deliverable that still runs end to end, then extend it.',
        )
      } else {
        answer = `I do not have a project in the graph that matches those skills yet. Name a skill you already have (for example "I know Arduino basics") and I will look for a project the graph connects to it.`
        nextActions.push('Open the Projects screen and filter by difficulty to see everything the graph currently offers.')
      }
      break
    }

    case 'explain-connection': {
      if (context.edges.length > 0 && context.skills.length >= 2) {
        const examples = context.edges.slice(0, 6).map((edge) => `(${nameOf(context, edge.from)}) -[:${edge.type}]-> (${nameOf(context, edge.to)})`)
        answer = [
          '**How these pieces connect**',
          '',
          'The graph stores explicit, labelled relationships. The ones relevant here are:',
          '',
          bullets(examples, 6),
          '',
          context.edges.some((edge) => edge.type === 'REQUIRES')
            ? '`REQUIRES` means "learn the right-hand side first". Other relationship types (USES, PRACTICED_BY, TAUGHT_BY) are supportive: they show how a skill is practised or where it is taught, not a hard ordering.'
            : 'These relationships are supportive rather than prerequisites, so order between them is flexible.',
        ].join('\n')
        nextActions.push('Open the Knowledge Graph with this skill selected to see the relationships visually.')
      } else {
        answer = `I need two or more connected entities in the graph to explain a connection. Try naming them both, for example "How do embedded systems connect electronics and programming?".`
        nextActions.push('Ask again naming two topics, or open the Knowledge Graph and search for the first one.')
      }
      break
    }

    case 'study-plan': {
      const hours = request.message.match(/(\d{1,2})\s*(?:hours?|hrs?)/i)?.[1]
      const weekly = hours ? Math.min(40, Math.max(1, Number(hours))) : 6
      const open = context.skills.filter((skill) => !skill.masteryState || skill.masteryState === 'unknown')
      const ordered = open.slice(0, 6)
      answer = [
        `**A ${weekly}-hour week, in dependency order**`,
        '',
        ordered.length > 0
          ? bullets(
              ordered.map(
                (skill, index) =>
                  `Week ${index + 1}: ${skill.name} (${skill.difficulty}) — ${skill.prerequisites.length === 0 ? 'no prerequisites in this slice' : `after ${skill.prerequisites.map((id) => nameOf(context, id)).join(', ')}`}.`,
              ),
              6,
            )
          : 'The graph slice has no open skills left; pick another career or mark more skills as unknown to re-plan.',
        '',
        `Split each week as roughly ${Math.max(1, Math.round(weekly * 0.7))} h learning and ${Math.max(1, Math.round(weekly * 0.3))} h hands-on practice. The roadmap generator does this automatically and lets you reschedule.`,
        '',
        CAVEATS.estimates,
      ].join('\n')
      nextActions.push(
        'Open My Roadmap → generate a plan, then adjust the weekly hours to match.',
        'Mark tasks as you finish them so the plan recalculates with real progress.',
      )
      break
    }

    case 'what-next': {
      const open = context.skills.filter((skill) => !skill.masteryState || skill.masteryState === 'unknown')
      const next = open.find((skill) => skill.prerequisites.every((id) => {
        const prereq = context.skills.find((s) => s.id === id)
        return !prereq || (prereq.masteryState && prereq.masteryState !== 'unknown')
      })) ?? open[0]
      if (next) {
        answer = [
          `**Next: ${next.name}** (${next.difficulty})`,
          '',
          next.prerequisites.length > 0
            ? `It sits on top of: ${next.prerequisites.map((id) => nameOf(context, id)).join(', ')}.`
            : 'It has no prerequisites inside this graph slice, so it is a safe starting point.',
          next.unlocks.length > 0 ? `After it you can move on to: ${next.unlocks.map((id) => nameOf(context, id)).join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join('\n')
        nextActions.push(
          `Study ${next.name} for about one week at your stated pace.`,
          next.unlocks.length > 0 ? `Then come back and ask about ${nameOf(context, next.unlocks[0])}.` : 'Then pick the next open skill from your roadmap.',
        )
      } else {
        answer = 'The graph slice has no open skills to suggest from. Choose a career goal first, then ask again.'
        nextActions.push('Open Explore Careers and select a target career.')
      }
      break
    }

    case 'career-overview': {
      answer = context.career
        ? [
            `**${context.career.name}**`,
            '',
            context.career.summary,
            '',
            `Skills the graph links to this career: ${context.skills.slice(0, 8).map((s) => s.name).join(', ')}.`,
            context.resources.length > 0
              ? `\nFree or freemium starting points: ${context.resources.slice(0, 3).map((r) => `${r.name} (${r.accessBadge})`).join('; ')}.`
              : '',
            '',
            CAVEATS.outcomes,
          ]
            .filter(Boolean)
            .join('\n')
        : 'I do not have a career matching that name in the graph. Try one of the twelve seeded careers, for example "Robotics and automation".'
      nextActions.push('Open Explore Careers to compare this career with two alternatives before committing.')
      break
    }

    case 'resource-help': {
      if (context.resources.length > 0) {
        answer = [
          '**Material the graph connects to these skills**',
          '',
          bullets(
            context.resources.map((resource) => `**${resource.name}** — ${resource.provider || 'provider unknown'} (${resource.accessBadge})`),
            6,
          ),
          '',
          'Access labels come from the resource records: "free to audit" means the material is readable but graded work or a certificate may be paid. Always check the provider page before planning around it.',
        ].join('\n')
        nextActions.push('Open the Resource Library and filter by access model if you need strictly free material.')
      } else {
        answer = 'I have no resources linked to those skills in the graph yet. The Resource Library lists everything currently verified.'
        nextActions.push('Open the Resource Library to browse by subject.')
      }
      break
    }

    default: {
      answer = [
        '**Here is what I can answer with graph data**',
        '',
        context.facts.length > 0 ? bullets(context.facts, 6) : 'The graph slice for this question was thin, so let me be honest: I do not have enough retrieved data to answer it well.',
        '',
        'I am strongest on: prerequisites and ordering ("why mechanics before robotics"), skill gaps for a target career, project suggestions from your current skills, study plans, and how two topics connect in the graph.',
      ].join('\n')
      if (context.unknowns.length > 0) {
        answer += `\n\n**What I could not ground:** ${context.unknowns.join(' ')}`
      }
      nextActions.push(
        'Name a career or skill from the graph and ask again for a grounded answer.',
        'Open Explore Careers if you are not sure which skills the graph covers.',
      )
      break
    }
  }

  if (mode === 'detailed' && intent !== 'general') {
    const extra = [
      '',
      '### How this was derived',
      ...(context.graphBasis.length > 0 ? bullets(context.graphBasis, 6) : ['The graph slice for this question contained no direct relationships.']),
      '',
      '### Honest limits',
      bullets([CAVEATS.selfReport, CAVEATS.estimates, CAVEATS.coverage], 3),
    ]
    answer += extra.join('\n')
  }

  return {
    id: `rules-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    intent,
    answer: answer.trim(),
    nextActions: nextActions.slice(0, 4),
    evidence: context.evidence,
    graphBasis: context.graphBasis,
    unknowns: context.unknowns,
    provider: 'rules',
    providerName: 'GraphMentor rules engine (no AI provider)',
    ...(options.degradedReason
      ? { degraded: { reason: options.degradedReason, retryable: true } }
      : {}),
    disclaimer: DISCLAIMER + detailsSuffix(mode),
  }
}

/** Used by the roadmap screen: a plain-language status line from real state. */
export function describeTaskStatus(status: Parameters<typeof taskStatusLabel>[0]): string {
  return `Status: ${taskStatusLabel(status)}`
}


