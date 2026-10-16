/**
 * Knowledge graph explorer — the signature screen.
 *
 * Capabilities (all reachable without a mouse):
 *   - start from a career, a skill, or a search over every entity,
 *   - bound the neighbourhood by depth, node type, relationship and difficulty,
 *   - highlight prerequisites and downstream skills,
 *   - trace the shortest path between two chosen nodes,
 *   - read everything again as a list/table for screen readers, printing and
 *     copying.
 *
 * Safety and honesty:
 *   - an unseeded request never asks the backend for the whole graph; the user is
 *     told to pick something, and the empty response explains why,
 *   - the payload is bounded (depth, node count) and truncation is reported,
 *   - the data source (live Neo4j vs bundled sample) is always on screen.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Boxes, GitBranch, Search, TableProperties } from 'lucide-react'

import {
  Button,
  Callout,
  Card,
  Chip,
  DifficultyBadge,
  EmptyState,
  ErrorNotice,
  Field,
  Grid,
  LinkButton,
  Loading,
  PageHeader,
  SectionTitle,
  Select,
  TextInput,
} from '@/components/ui.tsx'
import { LABEL_META, RELATION_META, explainRelationship } from '@core/graphModel.ts'
import { NODE_LABELS, RELATION_TYPES, type NodeLabel, type RelationType } from '@core/types.ts'
import { api } from '@/core/session.ts'
import { formatNumber } from '@/core/format.ts'
import { useAppStore } from '@/state/store.ts'
import { useClientQuery } from '@/features/shared/hooks.ts'
import { GraphCanvas } from './GraphCanvas.tsx'
import { Graph3D } from './Graph3D.tsx'

const DEFAULT_LABELS = NODE_LABELS.filter((label) => label !== 'Assessment')
const DEFAULT_RELATIONS = RELATION_TYPES.filter((type) => !RELATION_META[type].defaultHidden)

export function GraphPage(): ReactNode {
  const [params, setParams] = useSearchParams()
  const ui = useAppStore((state) => state.ui)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const toggleBookmark = useAppStore((state) => state.toggleBookmark)
  const pushToast = useAppStore((state) => state.pushToast)

  const seedId = params.get('seed')
  const careerId = params.get('career')
  const [depth, setDepth] = useState(1)
  const [limit, setLimit] = useState(60)
  const [labels, setLabels] = useState<NodeLabel[]>(DEFAULT_LABELS)
  const [relations, setRelations] = useState<RelationType[]>(DEFAULT_RELATIONS)
  const [difficulty, setDifficulty] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [pathTo, setPathTo] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(true)
  const [view, setView] = useState<'graph' | 'threed' | 'list'>('graph')

  const careers = useClientQuery(() => api().listCareers({}), [], 'the career list')

  const graph = useClientQuery(
    () =>
      api().getGraph({
        ...(seedId ? { seedId } : {}),
        ...(careerId && !seedId ? { careerId } : {}),
        depth,
        limit,
        labels,
        relations,
        ...(difficulty ? { difficulty } : {}),
      }),
    [seedId, careerId, depth, limit, labels.join(','), relations.join(','), difficulty],
    'the subgraph',
  )

  // Search resolves a free-text query to a node id using the career list plus a
  // local scan of the loaded subgraph, so no full-text index is required.
  const suggestions = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (term.length < 2) return []
    const fromGraph = (graph.data?.graph.nodes ?? []).map((node) => ({ id: node.id, name: node.name, label: node.label as NodeLabel }))
    const fromCareers = (careers.data?.careers ?? []).map((career) => ({ id: career.id, name: career.name, label: 'Career' as NodeLabel }))
    const unique = new Map<string, { id: string; name: string; label: NodeLabel }>()
    for (const item of [...fromCareers, ...fromGraph]) {
      if (item.name.toLowerCase().includes(term)) unique.set(item.id, item)
    }
    return [...unique.values()].slice(0, 8)
  }, [search, graph.data, careers.data])

  const selected = useMemo(
    () => graph.data?.graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.data, selectedId],
  )

  const selectedEdges = useMemo(() => {
    if (!graph.data || !selectedId) return { outgoing: [], incoming: [] }
    return {
      outgoing: graph.data.graph.edges.filter((edge) => edge.from === selectedId),
      incoming: graph.data.graph.edges.filter((edge) => edge.to === selectedId),
    }
  }, [graph.data, selectedId])

  /**
   * Node degrees for the list view. Computed once per subgraph rather than
   * filter-scanning every edge for every row (that was O(nodes × edges)).
   */
  const degrees = useMemo(() => {
    const out = new Map<string, number>()
    const incoming = new Map<string, number>()
    for (const edge of graph.data?.graph.edges ?? []) {
      out.set(edge.from, (out.get(edge.from) ?? 0) + 1)
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    }
    return { out, in: incoming }
  }, [graph.data])

  const nameOf = useCallback(
    (id: string): string => graph.data?.graph.nodes.find((node) => node.id === id)?.name ?? id.replace(/^\w+:/, '').replace(/-/g, ' '),
    [graph.data],
  )

  /**
   * Applies several URL-parameter changes as **one** navigation, and clears the
   * current selection.
   *
   * This has to be a single call into the router. React Router's
   * `setSearchParams` reads the search params of the current location through a
   * ref that is only updated *after* the navigation commits, so two calls in the
   * same event handler both start from the pre-navigation snapshot and the second
   * one wins. Choosing a career also clears `seed`, and that second call therefore
   * wrote back a URL with no career in it: the dropdown snapped back to "No career
   * selected", the panel kept saying "Choose a starting point", and the graph
   * never appeared. The functional form of `setSearchParams` does not help here —
   * the ref is stale either way — which is why the merging happens here instead.
   */
  const updateParams = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { replace: true })
    setSelectedId(null)
    setPathFrom(null)
    setPathTo(null)
  }

  const setParam = (key: string, value: string | null): void => updateParams({ [key]: value })

  useEffect(() => {
    if (graph.status === 'ready' && !selectedId && graph.data?.focusId) setSelectedId(graph.data.focusId)
  }, [graph.status, graph.data, selectedId])

  const hasSeed = Boolean(seedId || careerId)

  /* One panel instance, shared by the 2D and 3D viewers so both stay in step. */
  const nodePanel = (
    <NodePanel
      node={selected}
      nodes={graph.data?.graph.nodes ?? []}
      outgoing={selectedEdges.outgoing}
      incoming={selectedEdges.incoming}
      nameOf={nameOf}
      onSelect={setSelectedId}
      onUseAsSeed={(id) => setParam('seed', id)}
      bookmarked={bookmarks.some((bookmark) => bookmark.targetId === selectedId)}
      onBookmark={() => {
        if (!selected) return
        const type =
          selected.label === 'Project'
            ? 'project'
            : selected.label === 'Resource'
              ? 'resource'
              : selected.label === 'Career'
                ? 'career'
                : selected.label === 'LearningModule'
                  ? 'module'
                  : 'skill'
        const added = toggleBookmark({ targetType: type, targetId: selected.id })
        pushToast({ kind: 'success', message: added ? `Bookmarked ${selected.name}.` : 'Bookmark removed.' })
      }}
    />
  )

  return (
    <div>
      <PageHeader
        eyebrow="Knowledge graph explorer"
        title="Follow the dependencies, not the syllabus order"
        description="Nodes are careers, branches, subjects, concepts, skills, languages, tools, projects and resources. Edges are what actually connects them: prerequisites, membership, practice, coverage."
        actions={
          <>
            <div role="group" aria-label="View mode" className="flex overflow-hidden rounded-md border border-line">
              <button
                type="button"
                aria-pressed={view === 'graph'}
                onClick={() => setView('graph')}
                className={`px-3 py-1.5 text-sm ${view === 'graph' ? 'bg-[var(--gm-accent-soft)] text-accent' : 'text-muted'}`}
              >
                <GitBranch aria-hidden="true" className="mr-1 inline h-4 w-4" /> Canvas
              </button>
              <button
                type="button"
                aria-pressed={view === 'threed'}
                onClick={() => setView('threed')}
                className={`px-3 py-1.5 text-sm ${view === 'threed' ? 'bg-[var(--gm-accent-soft)] text-accent' : 'text-muted'}`}
              >
                <Boxes aria-hidden="true" className="mr-1 inline h-4 w-4" /> 3D
              </button>
              <button
                type="button"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
                className={`px-3 py-1.5 text-sm ${view === 'list' ? 'bg-[var(--gm-accent-soft)] text-accent' : 'text-muted'}`}
              >
                <TableProperties aria-hidden="true" className="mr-1 inline h-4 w-4" /> List
              </button>
            </div>
          </>
        }
      />

      <Grid cols={2}>
        <Card>
          <SectionTitle hint="everything is bounded, nothing loads the whole graph">Where to start</SectionTitle>
          <Field label="Career view" htmlFor="graph-career" hint="Shows the career, its skills, their tools and a few projects.">
            <Select
              id="graph-career"
              value={careerId ?? ''}
              onChange={(event) => updateParams({ career: event.target.value || null, seed: null })}
            >
              <option value="">No career selected</option>
              {(careers.data?.careers ?? []).map((career) => (
                <option key={career.id} value={career.id}>
                  {career.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Search a node"
            htmlFor="graph-search"
            hint="Matches careers and anything already visible in the current subgraph."
          >
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted" />
              <TextInput
                id="graph-search"
                className="pl-8"
                value={search}
                maxLength={60}
                placeholder="e.g. PID control, KiCad, calculus"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </Field>

          {suggestions.length > 0 ? (
            <ul className="mb-3 space-y-1">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    className="w-full rounded-md border border-line px-2 py-1.5 text-left text-sm hover:border-accent"
                    onClick={() => {
                      setParam('seed', suggestion.id === seedsKey(suggestion.id) ? null : suggestion.id)
                      setSearch('')
                    }}
                  >
                    <span className="font-medium">{suggestion.name}</span>{' '}
                    <span className="text-xs text-muted">{LABEL_META[suggestion.label]?.display ?? suggestion.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Hops from the seed" htmlFor="graph-depth" hint="1–3 hops keeps the view readable.">
              <Select id="graph-depth" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
              </Select>
            </Field>
            <Field label="Maximum nodes" htmlFor="graph-limit" hint="Hard cap, reported when it truncates.">
              <Select id="graph-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                <option value={30}>30</option>
                <option value={60}>60</option>
                <option value={120}>120</option>
                <option value={200}>200</option>
              </Select>
            </Field>
          </div>

          <Field label="Difficulty filter" htmlFor="graph-difficulty" hint="Keeps the seed node even if it does not match.">
            <Select id="graph-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">Any difficulty</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </Select>
          </Field>

          <div className="mt-2">
            <p className="gm-label">Highlight when a node is selected</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--gm-accent)]"
                checked={highlight}
                onChange={(event) => setHighlight(event.target.checked)}
              />
              Colour prerequisites and downstream skills
            </label>
            <p className="mt-1 text-xs text-muted">
              Amber = must come first, green = becomes reachable, everything else dims. The list view spells the same thing out
              in words.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!selectedId}
              onClick={() => setPathFrom(selectedId)}
            >
              Set path start
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!selectedId}
              onClick={() => setPathTo(selectedId)}
            >
              Set path end
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!pathFrom && !pathTo}
              onClick={() => {
                setPathFrom(null)
                setPathTo(null)
              }}
            >
              Clear path
            </Button>
          </div>
          {pathFrom || pathTo ? (
            <p className="mt-2 text-xs text-muted" aria-live="polite">
              Path: {pathFrom ? nameOf(pathFrom) : 'not set'} → {pathTo ? nameOf(pathTo) : 'not set'}
            </p>
          ) : null}
        </Card>

        <Card>
          <SectionTitle hint="narrow the payload instead of hiding nodes">Filters</SectionTitle>
          <p className="mb-2 text-xs text-muted">
            Node types and relationship types are sent to the backend, so a narrower selection means fewer rows fetched, not just
            fewer drawn.
          </p>
          <details open>
            <summary className="cursor-pointer text-sm font-medium">Node types ({labels.length} of {NODE_LABELS.length})</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {NODE_LABELS.map((label) => {
                const active = labels.includes(label)
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={active}
                    className={`gm-chip min-h-9 px-2.5 text-xs ${active ? 'border-accent text-accent' : 'text-muted'}`}
                    onClick={() => setLabels(active ? labels.filter((item) => item !== label) : [...labels, label])}
                  >
                    {LABEL_META[label]?.display ?? label}
                  </button>
                )
              })}
            </div>
          </details>

          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">
              Relationship types ({relations.length} of {RELATION_TYPES.length})
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {RELATION_TYPES.map((type) => {
                const active = relations.includes(type)
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={active}
                    title={RELATION_META[type]?.description}
                    className={`gm-chip min-h-9 px-2.5 text-xs ${active ? 'border-accent text-accent' : 'text-muted'}`}
                    onClick={() => setRelations(active ? relations.filter((item) => item !== type) : [...relations, type])}
                  >
                    {type.replace(/_/g, ' ').toLowerCase()}
                  </button>
                )
              })}
            </div>
          </details>

          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setLabels(DEFAULT_LABELS)
                setRelations(DEFAULT_RELATIONS)
                setDifficulty('')
                setDepth(1)
                setLimit(60)
              }}
            >
              Reset filters
            </Button>
          </div>

          <div className="mt-4">
            <h3 className="mb-1 text-sm font-semibold">Legend</h3>
            <ul className="grid grid-cols-1 gap-1 text-xs text-muted sm:grid-cols-2">
              {NODE_LABELS.map((label) => (
                <li key={label} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: LABEL_META[label]?.color }}
                  />
                  {LABEL_META[label]?.display ?? label}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </Grid>

      <div className="mt-5">
        {!hasSeed ? (
          <EmptyState title="Choose a starting point">
            Pick a career above, search for a node, or open a skill and press "Show in graph". Requests without a starting point
            are refused on purpose: loading the whole knowledge graph would be slow, unreadable, and would hide the structure that
            makes it useful.
          </EmptyState>
        ) : null}

        {hasSeed && graph.status === 'loading' ? <Loading label="Loading this neighbourhood…" /> : null}
        {hasSeed && graph.status === 'error' ? (
          <ErrorNotice message={graph.error?.message ?? 'The subgraph could not be loaded'} detail={graph.error?.detail} onRetry={graph.reload} />
        ) : null}

        {hasSeed && graph.status === 'ready' && graph.data ? (
          <div className="space-y-4">
            <Callout kind={graph.data.graph.truncated ? 'warning' : 'info'} title={graph.data.graph.selectionNote}>
              {formatNumber(graph.data.graph.nodes.length)} nodes and {formatNumber(graph.data.graph.edges.length)} relationships
              {graph.data.graph.truncated ? ' — the result was cut off by the depth/row limit. Narrow the filters or reduce the hops.' : '.'}{' '}
              {graph.meta?.source === 'local-sample'
                ? 'This is the bundled sample dataset running in your browser.'
                : 'This is live graph data from the backend.'}
            </Callout>

            {view === 'graph' ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
                <div>
                  <GraphCanvas
                    nodes={graph.data.graph.nodes}
                    edges={graph.data.graph.edges}
                    focusId={graph.data.focusId}
                    selectedId={selectedId}
                    pathFrom={pathFrom}
                    pathTo={pathTo}
                    highlightDownstream={highlight}
                    animate={ui.graphAnimations && !ui.reducedMotion}
                    onSelect={setSelectedId}
                  />
                </div>
                {nodePanel}
              </div>
            ) : null}

            {/* The 3D view reads the same bounded subgraph as the 2D canvas —
                it is another way of looking at one result, not a second query. */}
            {view === 'threed' ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
                <div>
                  <Graph3D
                    nodes={graph.data.graph.nodes}
                    edges={graph.data.graph.edges}
                    focusId={graph.data.focusId}
                    selectedId={selectedId}
                    highlightDownstream={highlight}
                    onSelect={setSelectedId}
                    truncated={graph.data.graph.truncated}
                    provenanceNote={
                      graph.meta?.source === 'local-sample'
                        ? 'Bundled sample dataset, rendered in your browser. No database round trip was involved.'
                        : 'Live graph data from Neo4j, rendered in your browser.'
                    }
                  />
                </div>
                {nodePanel}
              </div>
            ) : null}

            {view === 'list' ? (
              <Card>
                <SectionTitle hint="same data as the canvas, in text">Nodes</SectionTitle>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Nodes in the current subgraph with their type, difficulty and number of connections
                    </caption>
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                        <th scope="col" className="py-2 pr-3">Name</th>
                        <th scope="col" className="py-2 pr-3">Type</th>
                        <th scope="col" className="py-2 pr-3">Level</th>
                        <th scope="col" className="py-2 pr-3">Out</th>
                        <th scope="col" className="py-2">In</th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.data.graph.nodes.map((node) => (
                        <tr key={node.id} className="border-b border-line/60">
                          <td className="py-2 pr-3">
                            {node.label === 'Skill' ? (
                              <Link to={`/skills/${node.id}`} className="no-underline hover:underline">
                                {node.name}
                              </Link>
                            ) : (
                              <button type="button" className="text-left underline decoration-dotted" onClick={() => setSelectedId(node.id)}>
                                {node.name}
                              </button>
                            )}
                          </td>
                          <td className="py-2 pr-3">{LABEL_META[node.label]?.display ?? node.label}</td>
                          <td className="py-2 pr-3">{node.difficulty ? <DifficultyBadge difficulty={node.difficulty} /> : '—'}</td>
                          <td className="py-2 pr-3">{degrees.out.get(node.id) ?? 0}</td>
                          <td className="py-2">{degrees.in.get(node.id) ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : null}

            <Card>
              <SectionTitle hint="why two nodes are connected">Relationships in this view</SectionTitle>
              {graph.data.graph.edges.length === 0 ? (
                <p className="text-sm text-muted">No relationships in the current selection.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                  {graph.data.graph.edges.slice(0, 60).map((edge) => (
                    <li key={edge.id} className="truncate">
                      <span className="text-muted">
                        {explainRelationship(edge.type, nameOf(edge.from), nameOf(edge.to))}
                      </span>
                      {edge.weight !== undefined ? <span className="ml-1 text-xs text-muted"> (weight {edge.weight})</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {graph.data.graph.edges.length > 60 ? (
                <p className="mt-2 text-xs text-muted">
                  Showing the first 60 of {formatNumber(graph.data.graph.edges.length)} relationships. Narrow the filters to see
                  fewer, or use the list view for the full picture.
                </p>
              ) : null}
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Keeps the seed query parameter stable for the suggestions list. */
function seedsKey(id: string): string {
  return id
}

function NodePanel({
  node,
  nodes,
  outgoing,
  incoming,
  nameOf,
  onSelect,
  onUseAsSeed,
  bookmarked,
  onBookmark,
}: {
  node: { id: string; label: string; name: string; summary?: string; difficulty?: string } | null
  nodes: Array<{ id: string; name: string }>
  outgoing: Array<{ id: string; from: string; to: string; type: string }>
  incoming: Array<{ id: string; from: string; to: string; type: string }>
  nameOf: (id: string) => string
  onSelect: (id: string | null) => void
  onUseAsSeed: (id: string) => void
  bookmarked: boolean
  onBookmark: () => void
}): ReactNode {
  if (!node) {
    return (
      <Card>
        <SectionTitle>Selected node</SectionTitle>
        <p className="text-sm text-muted">Click a node on the canvas, or pick a row in the list view, to see its relationships here.</p>
        <p className="mt-2 text-xs text-muted">{nodes.length} nodes available in this view.</p>
      </Card>
    )
  }

  return (
    <Card>
      <SectionTitle hint={node.label}>{node.name}</SectionTitle>
      {node.summary ? <p className="text-sm text-muted">{node.summary}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {node.difficulty ? <DifficultyBadge difficulty={node.difficulty} /> : null}
        <Chip>{outgoing.length} outgoing</Chip>
        <Chip>{incoming.length} incoming</Chip>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onBookmark}>
          {bookmarked ? 'Remove bookmark' : 'Bookmark'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onUseAsSeed(node.id)}>
          Re-centre here
        </Button>
        {node.label === 'Skill' ? (
          <LinkButton to={`/skills/${node.id}`} size="sm" variant="ghost">
            Open skill page
          </LinkButton>
        ) : null}
        {node.label === 'Career' ? (
          <LinkButton to={`/careers/${node.id}`} size="sm" variant="ghost">
            Open career page
          </LinkButton>
        ) : null}
      </div>

      {outgoing.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Leads to</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {outgoing.slice(0, 12).map((edge) => (
              <li key={edge.id}>
                <button type="button" className="text-left no-underline hover:underline" onClick={() => onSelect(edge.to)}>
                  {nameOf(edge.to)}
                </button>{' '}
                <span className="text-xs text-muted" title={RELATION_META[edge.type as RelationType]?.description}>
                  {edge.type.replace(/_/g, ' ').toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {incoming.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Comes from</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {incoming.slice(0, 12).map((edge) => (
              <li key={edge.id}>
                <button type="button" className="text-left no-underline hover:underline" onClick={() => onSelect(edge.from)}>
                  {nameOf(edge.from)}
                </button>{' '}
                <span className="text-xs text-muted" title={RELATION_META[edge.type as RelationType]?.description}>
                  {edge.type.replace(/_/g, ' ').toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}


