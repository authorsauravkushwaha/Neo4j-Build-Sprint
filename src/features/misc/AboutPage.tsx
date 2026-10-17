/**
 * Features and limitations — the page the acceptance criteria require to be
 * prominent rather than buried.
 *
 * It lists what exists, what was verified, and what has *not* been verified in
 * this build. Nothing here is aspirational: if a capability is untested in this
 * environment, it says so.
 */
import { useEffect, useState, type ReactNode } from 'react'

import { Callout, Card, Chip, LinkButton, List, PageHeader, SectionTitle, Stat } from '@/components/ui.tsx'
import { datasetCounts, knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { config } from '@/core/env.ts'
import { sourceStatus, subscribeSession, type SessionState } from '@/core/session.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'
import { formatNumber } from '@/core/format.ts'

export function AboutPage(): ReactNode {
  const [sessionInfo, setSessionInfo] = useState<SessionState | null>(null)
  useEffect(() => subscribeSession(setSessionInfo), [])

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
              <Chip tone="success">Implemented</Chip> The repository includes a Neo4j driver reader, an explicit PostgreSQL alternative,
              bundled demo data, and source metadata on API results. The local recommendation engine is validated for all 17 careers.
              Regression tests and local checks are listed in the repository's
              verification report; the current command output, not an old count in this page, is authoritative.
            </p>
            <p>
              <Chip tone="warning">Production not established</Chip> This page cannot infer that Render, GitHub Pages, or a hosted Neo4j
              instance is configured. The actual service must pass the deployed HTTP verifier before a live production claim is made.
              See docs/architecture.md for the current evidence requirements.
            </p>
          </div>
        </Card>

        <Card>
          <SectionTitle hint="how the pieces fit">Architecture in one paragraph</SectionTitle>
          <p className="text-sm text-muted">
            The frontend never connects to the graph database directly. It calls the configured backend API. The Node backend can use
            Neo4j through the official Bolt driver, or PostgreSQL when explicitly configured; the separate Supabase Edge Functions
            deployment can use Neo4j's HTTPS Query API. With no reachable backend, the browser can use its bundled demo dataset. Each
            successful API response reports its actual source, and the UI does not infer LIVE NEO4J from configuration or a health ping.
            See docs/architecture.md for the request diagram and deployment settings.
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
          {sessionInfo
            ? `${sourceStatus(sessionInfo)} — ${sessionInfo.verifiedSource === 'neo4j-live'
                ? 'the most recent successful graph response included Neo4j source metadata.'
                : sessionInfo.verifiedSource === 'postgres-live'
                  ? 'the most recent successful graph response included PostgreSQL source metadata.'
                  : sessionInfo.verifiedSource === 'local-sample'
                    ? 'the current data is the bundled sample, not database results.'
                    : sessionInfo.health?.graphDetail ?? sessionInfo.fallbackReason ?? 'No successful graph-data response has confirmed a live source yet.'}`
            : 'Checking the current backend and graph source. A configured URL or health response alone does not prove that graph data was served.'}
        </Callout>
      </div>
    </div>
  )
}


