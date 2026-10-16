/**
 * The landing page — a scroll story, not a brochure.
 *
 * Shape of the page, and why:
 *
 *   1. **Hero.** The product's own 3D scene, three actions, and the honest
 *      sentence about what the scene is. The reader's first screen is unchanged
 *      from what the audience study measured: headline, lede, three calls to
 *      action, no scrolling required.
 *   2. **Why a list cannot answer this.** A pinned scene that argues the product's
 *      central claim by showing the difference between a list and a graph.
 *   3. **The graph, drawn from the reader's own frontier.** The same engine the
 *      gap page runs, drawn instead of listed, computed in the browser from the
 *      bundled curriculum.
 *   4. **The worked example.** Two stated profiles, the engine's own numbers, both
 *      of them recomputable — the block the audience study asked for and the
 *      reason it exists.
 *   5. **What runs it, and what it will not do.** Integrations named with their
 *      status, then the limits, then the security claims — in the same voice and
 *      at the same size as the features.
 *
 * Motion policy (the whole reason this page is built from `@/skiper`): the page
 * is a document first. Every scene has a stacked, static form for reduced motion
 * and for small screens, all copy is in the DOM from the first render, the
 * chapter bar is real navigation, and nothing here is required to be read.
 *
 * Content rules that apply here as everywhere else in the app:
 *   - no invented user counts, ratings, testimonials or success statistics,
 *   - no promise of a job, internship or salary,
 *   - the limitations section is as prominent as the features section.
 */
import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, BookMarked, Boxes, Compass, GitBranch, ListChecks, MessageSquare, Route, ShieldCheck, Sparkles, Target, Wifi, WifiOff } from 'lucide-react'

import { Card, Callout, Grid, LinkButton, List, SectionTitle, SkillLink } from '@/components/ui.tsx'
import { Scene3D } from '@/components/three/Scene3D.tsx'
import { buildHeroScene } from './HeroScene.ts'
import { useTilt } from '@/components/three/useTilt.ts'
import { datasetCounts, knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { api } from '@/core/session.ts'
import { formatHours, formatNumber, formatWeeks } from '@/core/format.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import { CountUpStat } from '@/skiper/components/Stats.tsx'
import { KineticHeadline, WordCycle } from '@/skiper/components/Kinetic.tsx'
import { Marquee } from '@/skiper/components/Marquee.tsx'
import { CardStack } from '@/skiper/components/Cards.tsx'
import { Reveal, RevealCss } from '@/skiper/components/Reveal.tsx'
import { ScrollScene } from '@/skiper/components/ScrollScene.tsx'
import { StoryNavBar } from '@/skiper/components/ScrollRail.tsx'
import { StoryPreloader } from '@/skiper/components/Preloader.tsx'
import { SpotlightCard } from '@/skiper/components/Buttons.tsx'
import { storyChapters } from './storyChapters.ts'
import { INTEGRATIONS, STORY_LIMITS, answerSceneSteps, graphSceneSteps, problemSceneSteps, StoryCta } from './storyScenes.tsx'

const FEATURES: Array<{ icon: ReactNode; title: string; body: string; to: string }> = [
  {
    icon: <Compass aria-hidden="true" className="h-5 w-5" />,
    title: 'Career explorer',
    body: `${datasetCounts.careers} engineering directions, each with the skills the curriculum treats as essential, the ones that are optional, plus common job titles and portfolio ideas.`,
    to: '/careers',
  },
  {
    icon: <GitBranch aria-hidden="true" className="h-5 w-5" />,
    title: 'Interactive knowledge graph',
    body: 'Zoom, pan, filter by node type and relationship, highlight prerequisites and downstream skills, and trace the path between any two nodes.',
    to: '/graph',
  },
  {
    icon: <Target aria-hidden="true" className="h-5 w-5" />,
    title: 'Skill-gap analyzer',
    body: 'Self-rate what you already know; the engine separates genuine prerequisites you are missing from nice-to-have specialisations.',
    to: '/gaps',
  },
  {
    icon: <Route aria-hidden="true" className="h-5 w-5" />,
    title: 'Dependency-aware roadmap',
    body: 'A weekly plan that never schedules a topic before its prerequisites, sized to the hours you actually have.',
    to: '/roadmap',
  },
  {
    icon: <Sparkles aria-hidden="true" className="h-5 w-5" />,
    title: 'Project recommender',
    body: `${datasetCounts.projects} buildable projects ranked by how much of your gap they close, with safety notes where hardware is involved.`,
    to: '/projects',
  },
  {
    icon: <BookMarked aria-hidden="true" className="h-5 w-5" />,
    title: 'Verified resource library',
    body: `${datasetCounts.resources} free or free-to-audit resources with an honest access label, so you know what a signup really gets you.`,
    to: '/resources',
  },
  {
    icon: <MessageSquare aria-hidden="true" className="h-5 w-5" />,
    title: 'Graph-grounded mentor',
    body: 'Ask why something comes first, what to build next, or what you are missing. Answers cite the graph, and say when it does not know.',
    to: '/mentor',
  },
  {
    icon: <ListChecks aria-hidden="true" className="h-5 w-5" />,
    title: 'Progress that stays yours',
    body: 'Track what you finished, hours spent and what needs review. Export or erase it whenever you want.',
    to: '/progress',
  },
]

/**
 * The worked example: what this thing actually produces, before anybody signs up.
 *
 * Round 1 of the audience simulation scored "no example output on the landing
 * page" as the most expensive defect in the product — severity 60, seven of the
 * fourteen personas — and it was right. The page argued for a graph, drew a
 * picture of one, and never once showed its output. So this block is that output:
 * the same engine the gap page uses, over the same bundled dataset, run twice —
 * once for somebody who has never studied the field and once for somebody already
 * working in it, with both input profiles written down beside the result. Nothing
 * here is typed by hand; change the engine and this changes with it. The fact
 * sheet measures it (`value.landingExampleNumbers`), and the browser suite checks
 * that the numbers here agree with the gap page's for the same inputs.
 */
const WORKED_CAREER = 'career:software-engineer'

/**
 * Essential-skill counts per career, derived from the same `REQUIRES_SKILL`
 * edges the career page reads — the same rule the dataset validator enforces
 * (`essential !== false` counts as essential). Derived here rather than typed in,
 * so a career card cannot claim a number the graph disagrees with.
 */
const ESSENTIAL_COUNTS = ((): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const edge of knowledgeGraph.edges) {
    if (edge.type !== 'REQUIRES_SKILL' || edge.essential === false) continue
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
  }
  return counts
})()

/** Stated inputs, not a profile scraped from anywhere. */
const WORKED_PROFILES = [
  {
    id: 'from-zero',
    title: 'Never studied the field',
    inputs: 'nothing rated yet · 8 h/week',
    ratings: [] as Array<{ skillId: string; state: string }>,
  },
  {
    id: 'in-field',
    title: 'Already working in the field',
    inputs: 'programming and Git rated confident, Linux practised · 8 h/week',
    ratings: [
      { skillId: 'skill:programming-fundamentals', state: 'confident' },
      { skillId: 'skill:version-control-git', state: 'confident' },
      { skillId: 'skill:operating-systems-and-linux', state: 'practised' },
    ],
  },
]

function WorkedExample(): ReactNode {
  const fromZero = useClientQuery(
    () => api().analyzeGaps({ careerId: WORKED_CAREER, ratings: [], weeklyHours: 8 }),
    [],
    'the worked example',
  )
  const inField = useClientQuery(
    () => api().analyzeGaps({ careerId: WORKED_CAREER, ratings: WORKED_PROFILES[1]!.ratings, weeklyHours: 8 }),
    [],
    'the worked example for somebody already in the field',
  )
  const runs = [fromZero, inField]

  return (
    <SpotlightCard className="mb-6">
      <SectionTitle hint="two runs of the same engine, with the inputs written down">
        What it answers, before you make an account
      </SectionTitle>
      <div data-testid="worked-example" className="grid gap-3 sm:grid-cols-2">
        {WORKED_PROFILES.map((profile, index) => {
          const query = runs[index]!
          const frontier = query.data?.frontier
          return (
            <div
              key={profile.id}
              data-testid={`worked-example-${profile.id}`}
              className="rounded-lg border border-line bg-[var(--gm-surface-2)] p-3"
            >
              <p className="text-sm font-semibold">{profile.title}</p>
              <p className="mt-0.5 text-xs text-muted">{profile.inputs}</p>
              {frontier ? (
                <>
                  <p className="mt-2 text-sm" data-testid={`worked-example-${profile.id}-summary`}>
                    {frontier.summaryLine}
                  </p>
                  {frontier.frontier.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {frontier.frontier.slice(0, 6).map((skill) => (
                        <SkillLink key={skill.skillId} skillId={skill.skillId} name={skill.name} difficulty={skill.difficulty} />
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-muted" data-testid={`worked-example-${profile.id}-effort`}>
                    {formatNumber(frontier.remainingCount)} skill(s) left · {formatHours([frontier.hours.low, frontier.hours.high])}
                    {frontier.hours.weeksAtWeeklyHours
                      ? ` · ${formatWeeks([frontier.hours.low, frontier.hours.high], 8)} at 8 h/week`
                      : ''}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {query.status === 'error' ? (query.error?.message ?? 'Could not run the engine here.') : 'Running the engine…'}
                </p>
              )}
            </div>
          )
        })}
      </div>
      {fromZero.data?.frontier ? (
        <p className="mt-3 text-xs text-muted" data-testid="worked-example-chain">
          The chain that cannot be shortened, from zero:{' '}
          {fromZero.data.frontier.criticalChain.map((step) => step.name).join(' → ')}.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        These are the tool's own numbers for {knowledgeGraph.careers.find((career) => career.id === WORKED_CAREER)?.name ?? WORKED_CAREER},
        computed on this page from the bundled curriculum by the same code that answers on the gap page. Estimates are planning
        aids, not promises.
      </p>
      <div className="mt-3">
        <LinkButton to={`/gaps?career=${encodeURIComponent(WORKED_CAREER)}`} variant="secondary" icon={<Target className="h-4 w-4" />}>
          Run it on your own profile
        </LinkButton>
      </div>
    </SpotlightCard>
  )
}

/**
 * The hero: copy on top of a real 3D scene.
 *
 * Two promises kept here:
 *   1. The scene is honest. It shows labelled node types and relationship
 *      edges — the same vocabulary as the knowledge graph — and it says beside
 *      itself that it is a fixed composition, not live data. The counts under
 *      it come from the dataset, not from the scene.
 *   2. It degrades. No WebGL (or reduced motion, or a data-saver connection)
 *      shows a flat CSS composition with the same message instead of a black
 *      rectangle, and the copy above it is unchanged.
 *
 * A third promise, added with the story build: the headline is the only
 * choreographed thing above the fold, and none of its movement changes layout.
 * The three actions are ordinary links in ordinary flow, inside `.gm-hero-copy`,
 * because the browser suite drives a real pointer at them and requires all three
 * to be reachable and on top on a 360×667 phone.
 */
function HeroStage(): ReactNode {
  const { ref, tiltProps } = useTilt<HTMLDivElement>({ max: 5, scale: 1.008, lift: 6 })

  return (
    <div className="gm-stage mb-4">
      <div
        ref={ref}
        {...tiltProps}
        className="gm-card gm-card-3d gm-sheen gm-tilt relative overflow-hidden px-4 py-6 sm:px-8 sm:py-12"
      >
        <div className="gm-hero-scene" aria-hidden="true">
          <Scene3D
            label="Knowledge graph in three dimensions"
            className="h-full w-full"
            build={buildHeroScene}
            fallback={<HeroFallback />}
          />
        </div>

        <span className="gm-hero-scrim" aria-hidden="true" />

        <span className="gm-halo gm-layer-back" style={{ inset: 'auto 6% -18% auto', width: '18rem', height: '18rem' }} aria-hidden="true" />

        <div className="gm-hero-copy relative">
          <p className="gm-label">Engineering career navigator</p>
          {/* One heading, written for the person who has never heard of a
              knowledge graph: the outcome first, the mechanism second. The
              short form is what a phone shows, because the phone's first screen
              belongs to the primary action. */}
          <h1 className="mt-1 max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl lg:text-5xl">
            <KineticHeadline
              as="span"
              className="sm:hidden"
              text="What to learn first"
              accent={['first']}
              immediate
            />
            <KineticHeadline
              as="span"
              className="hidden sm:inline"
              text="What to learn first, and how long the rest will take"
              accent={['first', 'long', 'rest', 'take']}
              immediate
            />
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted sm:text-lg">
            {/* Same claim, two lengths: the phone gets the thesis without the
                build-up, because the phone's first screen belongs to the
                primary action. See the hero note in docs/frontier.md. */}
            <span className="sm:hidden">
              Your skill gap for an engineering career: what to start with, what it unblocks, and how long the rest takes.
              No account needed.
            </span>
            <span className="hidden sm:inline">
              Pick an engineering career and GraphMentor shows your gap against its real prerequisites: what is worth
              starting now, which missing skill unblocks the most of the route, and the one chain that cannot be
              shortened. Every career, skill and project is a node in a prerequisite graph — that is why it can answer
              what a course list cannot. No account needed, and it keeps working offline.
            </span>
          </p>

          {/* The primary action goes to the answer, not to a setup screen: the
              question a stranger arrives with is "what would I have to learn",
              and /gaps answers it in zero clicks with nothing rated. Guided
              onboarding is the second action. Measured: the route from this page
              to a rendered answer is one click — see docs/audience-simulation.md. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <LinkButton to="/gaps" variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
              See what&rsquo;s missing
            </LinkButton>
            <LinkButton to="/onboarding" variant="secondary">
              Rate what I already know
            </LinkButton>
            <LinkButton to="/graph" variant="ghost" icon={<Boxes className="h-4 w-4" />}>
              Open the graph in 3D
            </LinkButton>
          </div>

          {/* The honest label stays, but it no longer competes with the offer:
              a scene caption instead of a paragraph. The full explanation — the
              one that says what the composition is and where the real, keyboard
              -and-screen-reader-accessible graph lives — sits in "What this app
              can and cannot do", which is one click away in the footer. */}
          <p className="mt-4 text-xs text-muted">Fixed composition behind this text — not live data. Drag it to spin.</p>
        </div>
      </div>

      {/* The scroll cue scrolls; it does not link. A fragment href inside the
          hero would be a second in-view anchor, and the browser suite requires
          exactly the three actions above to be the reachable ones. */}
      <p className="gm-hero-cue mt-2 flex items-center justify-center gap-2 text-xs text-muted">
        <span aria-hidden="true">↓</span>
        The rest of this page is the argument. Use the chapter bar to skip it.
      </p>
    </div>
  )
}

/** Shown when WebGL is unavailable: same palette, no GPU. */
function HeroFallback(): ReactNode {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute -left-10 top-6 h-40 w-40 rounded-full bg-[var(--gm-glow)] blur-3xl" />
      <div className="absolute right-4 top-24 h-52 w-52 rounded-full bg-[var(--gm-glow-2)] blur-3xl" />
      <div className="absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-[var(--gm-aurora-3)] blur-3xl" />
      <svg className="absolute inset-0 h-full w-full opacity-40" viewBox="0 0 100 60" preserveAspectRatio="none">
        <g stroke="var(--gm-border-strong)" strokeWidth="0.15" fill="none">
          <path d="M12 18 L34 30 L58 14 L80 26 M34 30 L46 44 L70 40 M58 14 L70 40" />
        </g>
        <g fill="var(--gm-accent)">
          <circle cx="12" cy="18" r="1.6" />
          <circle cx="58" cy="14" r="1.6" />
          <circle cx="80" cy="26" r="1.2" />
        </g>
        <g fill="var(--gm-violet)">
          <circle cx="34" cy="30" r="1.6" />
          <circle cx="46" cy="44" r="1.2" />
        </g>
        <g fill="var(--gm-success)">
          <circle cx="70" cy="40" r="1.2" />
        </g>
      </svg>
    </div>
  )
}

export function LandingPage(): ReactNode {
  // One engine run, shared by three scenes. It is the reader's own computation:
  // in sample mode it runs in this browser, and with a backend configured it is
  // the same function answering from Neo4j.
  const story = useClientQuery(
    () => api().analyzeGaps({ careerId: WORKED_CAREER, ratings: [], weeklyHours: 8 }),
    [],
    'the story',
  )
  const frontier = story.data?.frontier ?? null

  return (
    <div className="gm-story">
      <StoryPreloader />

      <HeroStage />

      <StoryNavBar chapters={storyChapters} title="Scenes" />

      <ScrollScene
        id="why"
        heading="Why a course list cannot answer this"
        hint="Three scenes, about forty seconds of scrolling — or read the same words in order without any of it."
        steps={problemSceneSteps()}
      />

      {frontier ? (
        <ScrollScene
          id="graph"
          heading="The graph, answered for you"
          hint={`Computed just now for ${frontier.careerName} from the bundled curriculum. Nothing on this page was written for it in advance.`}
          steps={graphSceneSteps(frontier)}
          footer={<StoryCta />}
        />
      ) : (
        <section id="graph" className="gm-scene" aria-labelledby="graph-heading">
          <header className="gm-scene-head">
            <h2 id="graph-heading" className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
              The graph, answered for you
            </h2>
            <p className="mt-1 text-sm text-muted" role="status">
              {story.status === 'error'
                ? (story.error?.message ?? 'The frontier engine could not run here.')
                : 'Running the frontier engine over the bundled curriculum…'}
            </p>
          </header>
        </section>
      )}

      <ScrollScene
        id="answer"
        heading="What comes back"
        hint="The three answers the engine gives a beginner, in the order they matter."
        steps={frontier ? answerSceneSteps(frontier) : []}
      />

      <section id="worked" className="gm-scene" aria-label="The worked example">
        <WorkedExample />
      </section>

      <Reveal as="div" className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Careers', value: datasetCounts.careers },
          { label: 'Skills', value: datasetCounts.skills },
          { label: 'Projects', value: datasetCounts.projects },
          { label: 'Resources', value: datasetCounts.resources },
        ].map((item) => (
          <CountUpStat key={item.label} value={item.value} label={item.label} testId={`story-stat-${item.label.toLowerCase()}`} />
        ))}
      </Reveal>

      <Callout kind="info" title="These counts describe this app's bundled curriculum">
        They are not user numbers, downloads or ratings. The graph is a curated sample: {datasetCounts.edges} relationships
        authored from public syllabi and documentation, with every link and access model written down honestly. Curriculum
        version {knowledgeGraph.version} — `npm run validate:seed` fails if that number and the shipped dataset disagree.
      </Callout>

      {/* ---------------------------------------------------------------------
          The careers band. Two presentations of the same thirteen records: a
          marquee for breadth, a card stack for browsing. Both link to the same
          pages, and reduced motion renders both as lists.
      */}
      <section id="careers" className="mt-8" aria-labelledby="careers-heading">
        <SectionTitle hint={`all ${datasetCounts.careers} of them, straight from the dataset`}>
          <span id="careers-heading">Engineering directions in this curriculum</span>
        </SectionTitle>
        <Reveal as="div" className="mb-4">
          <Marquee
            label="Careers in this curriculum"
            items={knowledgeGraph.careers.map((career) => ({
              key: career.id,
              node: (
                <Link
                  to={`/careers/${encodeURIComponent(career.id)}`}
                  className="gm-chip inline-flex min-h-9 items-center gap-1.5 px-2.5 text-sm no-underline"
                >
                  {career.name}
                </Link>
              ),
            }))}
          />
        </Reveal>

        <CardStack
          label="Career cards"
          items={knowledgeGraph.careers.map((career) => ({
            key: career.id,
            label: career.name,
            content: (
              <Card as="article">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-ink">{career.name}</h3>
                  <span className="gm-label">{ESSENTIAL_COUNTS.get(career.id) ?? 0} essential</span>
                </div>
                <p className="mt-2 text-sm text-muted">{career.summary}</p>
                <Link
                  to={`/careers/${encodeURIComponent(career.id)}`}
                  className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-accent no-underline hover:bg-[var(--gm-accent-soft)] focus-visible:bg-[var(--gm-accent-soft)]"
                >
                  Open <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="sr-only">{career.name}</span>
                </Link>
              </Card>
            ),
          }))}
        />
      </section>

      {/* ---------------------------------------------------------------------
          Who this is for — the question every "learn to code" site answers with
          a slogan. The honest answer is that the same graph answers two
          different questions, and which one you get depends only on what you
          tell it.
      */}
      <div className="mt-8">
        <SectionTitle hint="two people, one engine, no slogan">Who this is for</SectionTitle>
        <Grid cols={2}>
          <Card as="article">
            <h3 className="text-base font-semibold text-ink">You have not studied any of this yet</h3>
            <p className="mt-2 text-sm text-muted">
              You get one short list of skills that nothing else depends on — the ones you can genuinely start today — and
              the single chain that has to be done in order. Not a catalogue of a hundred courses ranked by nothing. Set
              your weekly hours and the graph turns the whole route into a range of weeks, so "should I start" becomes a
              question you can actually answer.
            </p>
            <p className="mt-2 text-xs text-muted">
              No account, no sign-in, no AI key: the analysis runs in your browser from the bundled curriculum.
            </p>
          </Card>
          <Card as="article">
            <h3 className="text-base font-semibold text-ink">You already work in this field</h3>
            <p className="mt-2 text-sm text-muted">
              The same page answers the harder question: rate what you know and it returns your delta, not a curriculum.
              Which remaining skills gate the others — and how much of the route each one unblocks, counted once and never
              added up twice — plus the longest prerequisite chain that extra hours cannot shorten. Prerequisites the
              career's own list never mentions are called out separately, which is usually where experienced people find
              the hole they did not know they had.
            </p>
            <p className="mt-2 text-xs text-muted">
              Every number is a graph computation you can re-run, and re-derived independently in Java as part of the
              verification suite — not an estimate from a model.
            </p>
          </Card>
        </Grid>
        <p className="mt-3 text-sm text-muted">
          Both readings are one control away from each other, on the same screen:{' '}
          <Link to="/gaps" className="font-medium text-accent no-underline hover:underline">
            open the skill-gap analyzer
          </Link>{' '}
          and either leave the ratings empty or fill them in.
        </p>
      </div>

      {/* ---------------------------------------------------------------------
          The platform band. Named upstream projects, each with an honest status:
          what is wired up here, and what is an adapter or a tool.
      */}
      <section id="platform" className="mt-8" aria-labelledby="platform-heading">
        <SectionTitle hint="named, with what actually runs and what it cannot promise">
          <span id="platform-heading">What it is built on</span>
        </SectionTitle>
        <div className="gm-integrations">
          {INTEGRATIONS.map((integration, index) => (
            <RevealCss key={integration.name} as="article" index={index} className="gm-card p-3">
              <div className="gm-integration-head">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="text-accent">{integration.icon}</span>
                  {integration.name}
                </h3>
                <span className="gm-integration-status">{integration.status}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{integration.body}</p>
            </RevealCss>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Each of these is in the repository with its own documentation and tests, and each one is optional at runtime: with
          no database and no keys, the app runs in a clearly labelled local sample mode rather than pretending to be live.
        </p>
      </section>

      {/* ---------------------------------------------------------------------
          What it cannot do. Stated in the story, not only on the limits page.
      */}
      <section id="limits" className="mt-8" aria-labelledby="limits-heading">
        <SectionTitle hint="read this before you rely on anything here">
          <span id="limits-heading">What GraphMentor does not do</span>
        </SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {STORY_LIMITS.map((limit, index) => (
            <RevealCss key={limit.title} as="article" index={index} className="gm-card p-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <span className="text-accent">{limit.icon}</span>
                {limit.title}
              </h3>
              <p className="mt-2 text-sm text-muted">{limit.body}</p>
            </RevealCss>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <SectionTitle hint="the short version">The same list, in full</SectionTitle>
            <List
              items={[
                'It does not guarantee a job, internship, visa, admission or salary. Nobody can, and any tool that says so is lying to you.',
                'It does not issue certificates. The short checks are self-assessed practice, explicitly not credentials.',
                'It does not know your local job market, university requirements or employer expectations.',
                'It does not replace a teacher, mentor or official documentation.',
                'Its hour estimates are curriculum averages, not measurements of your pace.',
              ]}
            />
          </Card>
          <Card>
            <SectionTitle hint="how the data actually flows">How it stays honest</SectionTitle>
            <List
              items={[
                'Live mode reads Neo4j through Supabase Edge Functions. Database credentials never reach the browser.',
                'Without a database configured, the browser runs the same engine over the bundled sample dataset and labels it as sample data on every screen.',
                'Recommendations come from a documented, deterministic scoring formula — the weights are printed in docs/recommendation-engine.md and in the code that uses them.',
                'The AI mentor is optional. With no API key, a rules engine answers from the same graph context — nothing you ask leaves your device.',
                'Guest progress is stored only in your browser, with export and erase controls in Settings.',
              ]}
            />
          </Card>
        </div>
      </section>

      <div className="mt-6">
        <SectionTitle hint="every screen below works without an account">What you can do here</SectionTitle>
        <Grid cols={3}>
          {FEATURES.map((feature, index) => (
            <RevealCss key={feature.title} as="article" index={index} className="gm-card p-3">
              <div className="mb-2 flex items-center gap-2 text-accent">
                {feature.icon}
                <h3 className="text-base font-semibold text-ink">{feature.title}</h3>
              </div>
              <p className="text-sm text-muted">{feature.body}</p>
              {/* A 20 px-tall "Open" link failed the WCAG 2.5.8 minimum target
                  size check in a real browser (it was measured, not guessed).
                  It is now a real control with padding, and the arrow is part of
                  the target rather than an adjacent decoration. */}
              <Link
                to={feature.to}
                className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-accent no-underline hover:bg-[var(--gm-accent-soft)] focus-visible:bg-[var(--gm-accent-soft)]"
              >
                Open <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="sr-only">{feature.title}</span>
              </Link>
            </RevealCss>
          ))}
        </Grid>
      </div>

      {/* ---------------------------------------------------------------------
          Security and privacy, in plain terms. Every claim below is checked by
          a named test; see docs/security.md for the mapping.
      */}
      <section id="security" className="mt-8" aria-labelledby="security-heading">
        <SectionTitle hint="the controls are implemented, tested and documented — not promised">
          <span id="security-heading">Security and privacy, in plain terms</span>
        </SectionTitle>
        <Grid cols={2}>
          <Card as="article">
            <div className="mb-2 flex items-center gap-2 text-accent">
              <ShieldCheck aria-hidden="true" className="h-5 w-5" />
              <h3 className="text-base font-semibold text-ink">What is defended, and where</h3>
            </div>
            <List
              items={[
                'Injection: every query is parameterised, and identifiers come from allow-lists. Unknown request fields are rejected, not ignored.',
                'Authentication is separate from authorization: the server checks row ownership on every read and write, and the database repeats the check with row-level security.',
                'Rate limiting on chat, analysis and writes; replay protection with a signed request and a single-use nonce.',
                'Sign-in attempts are rate limited per address and per network before they reach the identity provider. Your email is hashed first, so the counter cannot read it.',
                'Sign-in failures say the same thing whether or not an address has an account here, and sessions can be revoked on every device at once.',
                'Long-password denial of service and catastrophic backtracking (ReDoS) are both bounded in code, with tests that pin the limits.',
                'Errors are mapped to a fixed vocabulary: no SQL, no stack traces, no file paths, no upstream messages.',
              ]}
            />
          </Card>
          <Card as="article">
            <div className="mb-2 flex items-center gap-2 text-accent">
              <ShieldCheck aria-hidden="true" className="h-5 w-5" />
              <h3 className="text-base font-semibold text-ink">What this app will never do</h3>
            </div>
            <List
              items={[
                'It will not read your clipboard. Copy actions are explicit, user-triggered, and nothing is ever pasted in automatically.',
                'It will not ask for a file upload. There is no upload endpoint, no storage bucket and no file input anywhere in the app.',
                'It will not put an API key, database password or service key in the browser. The only public key shipped is the one that is safe by design.',
                'It will not store your password, put one in a link, or email you asking for it. Password sign-in goes straight to the identity provider and the app keeps nothing.',
                'It will not tell you whether an email address has an account here, and it will not claim a save succeeded when it did not.',
                'It will not sell, share or profile your data. There is no analytics code in this build at all.',
              ]}
            />
          </Card>
        </Grid>
        <p className="mt-2 text-xs text-muted">
          The full mapping — including what is explicitly out of scope — is in <code>docs/security.md</code>. Reporting a
          security problem is described there too; please do not open a public issue for a live exploit. The repository also
          ships an adversarial self-audit (<code>npm run audit:self</code>) that probes this build&rsquo;s own endpoints for
          exactly these failure modes and fails CI when it finds one.
        </p>
      </section>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Callout kind="success" title="Works offline">
          <span className="inline-flex items-center gap-1">
            <WifiOff aria-hidden="true" className="h-4 w-4" /> Installable as an app; the shell and the sample dataset are cached.
          </span>
        </Callout>
        <Callout kind="info" title="Works online">
          <span className="inline-flex items-center gap-1">
            <Wifi aria-hidden="true" className="h-4 w-4" /> With a backend configured, the same screens read the live Neo4j graph.
          </span>
        </Callout>
      </div>

      <section id="next" className="gm-scene" aria-labelledby="next-heading">
        <div className="flex flex-wrap items-center gap-3">
          <LinkButton to="/onboarding" variant="primary">
            Set up a plan in about a minute
          </LinkButton>
          <LinkButton to="/graph" variant="secondary">
            Look at the graph first
          </LinkButton>
        </div>
        <p className="mt-3 text-sm text-muted" id="next-heading">
          Start with{' '}
          <WordCycle words={['a career', 'a skill', 'a project', 'a question']} /> and the graph does the ordering.
        </p>
      </section>
    </div>
  )
}
