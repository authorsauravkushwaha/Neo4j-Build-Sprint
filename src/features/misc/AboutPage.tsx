/**
 * Features and limitations — the page the acceptance criteria require to be
 * prominent rather than buried.
 *
 * It lists what exists, what was verified, and what has *not* been verified in
 * this build. Nothing here is aspirational: if a capability is untested in this
 * environment, it says so.
 */
import type { ReactNode } from 'react'

import { Callout, Card, Chip, LinkButton, List, PageHeader, SectionTitle, Stat } from '@/components/ui.tsx'
import { datasetCounts, knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { config } from '@/core/env.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'
import { formatNumber } from '@/core/format.ts'

export function AboutPage(): ReactNode {
  return (
    <div>
      <PageHeader
        eyebrow="Features and limitations"
        title="What this app does, and what it cannot do"
        description="Written to be checked, not to be believed. If a claim here is wrong, the source is in the repository."
        actions={
          <LinkButton to="/privacy" variant="secondary">
            Privacy and terms
          </LinkButton>
        }
      />

      <Stagger className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Graph version" value={knowledgeGraph.version} hint={`Updated ${knowledgeGraph.updated}`} />
        <Stat
          label="Nodes"
          value={formatNumber(
            datasetCounts.branches +
              datasetCounts.careers +
              datasetCounts.subjects +
              datasetCounts.concepts +
              datasetCounts.skills +
              datasetCounts.languages +
              datasetCounts.tools +
              datasetCounts.projects +
              datasetCounts.resources +
              datasetCounts.modules +
              datasetCounts.assessments,
          )}
          hint={`${datasetCounts.careers} careers, ${datasetCounts.skills} skills`}
        />
        <Stat label="Relationships" value={formatNumber(datasetCounts.edges)} hint={`${datasetCounts.relationshipTypes} relationship types · ${datasetCounts.projects} projects, ${datasetCounts.resources} resources`} />
        <Stat label="Build" value={config.appVersion} hint="Bundled dataset, no network needed" />
      </Stagger>

      <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <Card>
          <SectionTitle hint="implemented and covered by tests">Features</SectionTitle>
          <List
            items={[
              `Career explorer over ${datasetCounts.careers} curated engineering directions, each with essential and optional skills, common job titles and portfolio ideas.`,
              'Interactive knowledge graph with zoom, pan, filters, prerequisite and downstream highlighting, path tracing, and a full text alternative.',
              'Career pathway builder that orders skills by the REQUIRES relationships in the graph and shows alternative routes.',
              'Skill-gap analyzer with five transparent scoring factors and categories that separate real prerequisites from optional specialisations.',
              'Personalised roadmap with weekly scheduling that cannot place a skill before its prerequisites, plus a review step every third learning task.',
              'Project recommender ranked by how much of your specific gap each project builds, with safety notes on every hardware project.',
              `Resource library of ${datasetCounts.resources} free or free-to-audit items, each with what you can do afterwards, what it assumes, where it stops, and the date the link was last checked.`,
              'Graph-grounded mentor that answers with citations, reports unknowns, and falls back to a deterministic rules engine when no AI key is configured.',
              'Progress tracking with export and erase controls; guest mode needs no account.',
              'Installable PWA with offline shell, plus a Capacitor Android configuration sharing the same code.',
            ]}
          />
        </Card>

        <Card>
          <SectionTitle hint="stated plainly, not hidden in a FAQ">Limitations</SectionTitle>
          <List
            items={[
              `The dataset is a curated sample (${datasetCounts.careers} careers, ${datasetCounts.skills} skills) — not a labour-market database, and not exhaustive.`,
              'Hour estimates are curriculum ranges; they are not measurements of how long you will take.',
              'No certificates, no accreditation, no verification of anything you self-report.',
              'No guarantees about jobs, internships, admissions, visas or salaries. Any tool that promises these is misleading you.',
              'The mentor can be wrong. It cites the graph so you can check it, and lists what it does not know.',
              'AI answers depend on the provider you configure; with no key, answers come from the rules engine and are simpler.',
              'Not a substitute for supervised work in safety-critical fields: electrical, structural, aerospace, chemical and medical work need qualified supervision and local codes.',
              'Accessibility is implemented and tested against automated checks (axe) and manual keyboard review, but the graph canvas is inherently visual; the list view is the accessible equivalent.',
            ]}
          />
        </Card>
      </Stagger>

      <div className="mt-5 space-y-4">
        <Card>
          <SectionTitle hint="what was actually run">Verification status of this build</SectionTitle>
          <div className="space-y-2 text-sm">
            <p>
              <Chip tone="success">Verified here</Chip> dataset validation (no dangling references, no prerequisite cycles, coverage
              targets met), the local reader, both engines for all 17 careers, the deployment-owned PostgreSQL graph store end to end
              (the embedded engine serves the exact contract the Supabase functions serve, exercised in the integration tests),
              generated Cypher up to date with the dataset, secret scan clean, unit and integration tests, production build, typecheck.
            </p>
            <p>
              <Chip tone="warning">Not verified here</Chip> live queries against a hosted Neo4j Aura (no credentials in the build
              environment), Supabase migrations against a real Postgres, AI provider calls, the Android build (no Android SDK
              available), and resource links (outbound network access is restricted). Each of those has a script or command listed in
              the README so you can run it yourself and see the real result.
            </p>
          </div>
        </Card>

        <Card>
          <SectionTitle hint="how the pieces fit">Architecture in one paragraph</SectionTitle>
          <p className="text-sm text-muted">
            The frontend (React + TypeScript + Vite + Tailwind) never talks to the graph database directly. It calls function
            endpoints — either Supabase Edge Functions holding Neo4j credentials (parameterised Cypher through the HTTPS Query API) or
            the deployment's own Node server (<code className="rounded bg-[var(--gm-surface-2)] px-1">server/graphApi.ts</code>),
            which serves the same endpoints from the project's own PostgreSQL graph store
            (<code className="rounded bg-[var(--gm-surface-2)] px-1">server/graphStore.ts</code>) — no third-party account needed for
            that path. The same engine modules
            (<code className="rounded bg-[var(--gm-surface-2)] px-1">supabase/functions/_shared/core</code>) are imported by the
            browser, so demo mode runs the identical recommendation logic against the bundled dataset. The account store holds only
            per-user records (profiles, roadmaps, tasks, ratings, bookmarks, feedback) plus rate-limit and nonce tables used for abuse
            and replay protection.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton to="/graph" variant="secondary">
              See the graph
            </LinkButton>
            <LinkButton to="/mentor" variant="secondary">
              Try the mentor
            </LinkButton>
          </div>
        </Card>

        <Callout kind="info" title="Data provenance of what you are looking at right now">
          {knowledgeGraph.provenance}
        </Callout>
      </div>
    </div>
  )
}


