/**
 * The public API catalogue.
 *
 * This page is the surface the imported data was always for: a learner who has
 * just finished "HTTP basics" should be able to point at something real and
 * callable, filtered by the skills they are actually working on — not at another
 * course, and not at a list of 2,000 links.
 *
 * Three rules govern every pixel of it, and they are the reason it took a page to
 * show a table:
 *
 *   1. **The caveats are on the page, not in a footnote.** `publicApiProvenance()`
 *      returns them; they are rendered in full, above the results, in the same
 *      voice as everything else. A list of links that hides its vintage is a trap.
 *   2. **Nothing is embellished.** `auth` and `cors` are upstream's columns, quoted.
 *      An `apiKey` entry is labelled *needs a key* — never "free" — and the two rows
 *      whose link is plaintext `http://` while upstream's HTTPS column says `Yes`
 *      carry a warning rather than a tidy-up. The filter card can also hide them
 *      entirely, which is a choice the reader makes rather than one made for them.
 *   3. **No recommendation language.** An entry is here because calling it exercises
 *      a skill, and the card says which. It never says "recommended for you".
 *
 * The catalogue is a large generated module (84 KB), so this page is lazy-loaded
 * in `App.tsx` like the graph explorer and the roadmap.
 */
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, KeyRound, ShieldAlert } from 'lucide-react'

import { Callout, Card, Chip, EmptyState, Field, Grid, LinkButton, PageHeader, SectionTitle, Select, TextInput, Stat } from '@/components/ui.tsx'
import { formatNumber } from '@/core/format.ts'
import { useTextParam } from '@/features/shared/hooks.ts'
import { listPublicApis, publicApiCategories, publicApiProvenance, type PublicApiMatch } from '@/data/publicApis/index.ts'
import { knowledgeGraph } from '@/data/seed/knowledgeGraph.ts'
import { Stagger } from '@/skiper/components/Stagger.tsx'

/** The skills the curriculum actually defines, so the filter cannot offer a typo. */
const SKILL_OPTIONS: ReadonlyArray<{ id: string; name: string }> = [...knowledgeGraph.skills]
  .map((skill) => ({ id: skill.id, name: skill.name }))
  .sort((left, right) => left.name.localeCompare(right.name))

/** Upstream's `auth` column, in words a reader can act on. */
function authLabel(auth: string): { label: string; needsKey: boolean } {
  const normalised = auth.trim().toLowerCase()
  if (normalised === 'no') return { label: 'No key needed', needsKey: false }
  if (normalised === 'oauth') return { label: 'OAuth sign-in', needsKey: true }
  if (normalised === 'apiKey'.toLowerCase()) return { label: 'Needs an API key', needsKey: true }
  // Anything else is upstream saying something we did not verify — so it is quoted.
  return { label: `Auth: ${auth}`, needsKey: true }
}

function corsChip(cors: PublicApiMatch['cors']): ReactNode {
  if (cors === 'Yes') return <Chip tone="success">Browser-callable</Chip>
  if (cors === 'No') return <Chip tone="danger">CORS: No</Chip>
  return <Chip tone="warning">CORS: Unknown</Chip>
}

export function ApisPage(): ReactNode {
  const [query, setQuery] = useTextParam('q')
  const [category, setCategory] = useTextParam('category')
  const [skillId, setSkillId] = useTextParam('skill')
  const [noKey, setNoKey] = useTextParam('auth')

  const provenance = publicApiProvenance()
  const categories = publicApiCategories()

  const matches = useMemo(
    () =>
      listPublicApis({
        ...(query ? { q: query } : {}),
        ...(category ? { category } : {}),
        ...(skillId ? { skillIds: [skillId] } : {}),
        limit: 60,
      }),
    [query, category, skillId],
  )
  const visible = noKey === 'none' ? matches.filter((entry) => entry.auth.trim().toLowerCase() === 'no') : matches
  const plaintext = visible.filter((entry) => entry.linkScheme === 'http').length

  return (
    <div>
      <PageHeader
        eyebrow="Practice targets"
        title="Public APIs you can call while the lesson is still fresh"
        description={`${formatNumber(provenance.rowsKept)} entries imported from the public-apis directory, linked to the skills each one exercises. Imported, not live — the read date is on this page, and so is everything the directory does not tell you.`}
        actions={
          <>
            <LinkButton to="/skills" variant="secondary">
              Browse the skills
            </LinkButton>
            <LinkButton to="/workflows" variant="secondary">
              See the workflow that maps them
            </LinkButton>
          </>
        }
      />

      <Stagger className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Entries" value={formatNumber(provenance.rowsKept)} hint={`of ${formatNumber(provenance.rowsTotal)} upstream rows`} />
        <Stat label="Categories" value={formatNumber(provenance.categories.length)} hint="mapped to the curriculum" />
        <Stat label="Read on" value={provenance.rowsRead} hint={`commit ${provenance.commit.slice(0, 7)}`} />
        <Stat
          label="Plaintext links"
          value={formatNumber(provenance.plaintextLinks)}
          hint="upstream says HTTPS Yes and links to http://"
        />
      </Stagger>

      <Card className="mb-5">
        <Grid cols={3}>
          <Field label="Search" htmlFor="api-search">
            <TextInput
              id="api-search"
              value={query}
              maxLength={60}
              placeholder="e.g. weather, geocoding, jobs"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field label="Category" htmlFor="api-category">
            <Select id="api-category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Any category</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Skill it exercises" htmlFor="api-skill">
            <Select id="api-skill" value={skillId} onChange={(event) => setSkillId(event.target.value)}>
              <option value="">Any skill</option>
              {SKILL_OPTIONS.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </Select>
          </Field>
        </Grid>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Key required" htmlFor="api-auth">
            <Select id="api-auth" value={noKey} onChange={(event) => setNoKey(event.target.value)}>
              <option value="">Any</option>
              <option value="none">Only entries that need no key</option>
            </Select>
          </Field>
          <div className="flex items-end sm:col-span-2">
            <p aria-live="polite" className="text-xs text-muted">
              {formatNumber(visible.length)} shown
              {visible.length === 60 ? ' (the first 60 — narrow the search to see the rest)' : ''} · links open in a new tab; nothing
              here is tracked, and this filtered view is a link you can share.
            </p>
          </div>
        </div>
      </Card>

      {visible.length === 0 ? (
        <EmptyState title="Nothing matches those filters">
          Try a shorter word, or clear the skill filter. The catalogue is {formatNumber(provenance.rowsKept)} entries, kept
          deliberately small: a list of 2,000 endpoints is a haystack, not guidance.
        </EmptyState>
      ) : null}

      {plaintext > 0 ? (
        <div className="mb-4">
          <Callout kind="warning" title="A plaintext link is in these results">
            Upstream's HTTPS column says <em>Yes</em> for something whose own link is <code>http://</code>. Those rows are kept
            and marked rather than quietly fixed — rewriting the URL would invent a link, and dropping the row would hide one.
            Treat their documentation as reachable and the endpoint as unverified.
          </Callout>
        </div>
      ) : null}

      <Stagger className="space-y-3">
        {visible.map((entry) => {
          const auth = authLabel(entry.auth)
          return (
            <Card key={`${entry.name}-${entry.url}`} as="article">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{entry.name}</h2>
                    <Chip>{entry.category}</Chip>
                    <Chip tone={auth.needsKey ? 'warning' : 'success'}>
                      {auth.needsKey ? <KeyRound aria-hidden="true" className="mr-1 inline h-3 w-3" /> : null}
                      {auth.label}
                    </Chip>
                    {corsChip(entry.cors)}
                    {entry.linkScheme === 'http' ? (
                      <Chip tone="danger" title="Upstream declares HTTPS support; the published link is plaintext http://">
                        <ShieldAlert aria-hidden="true" className="mr-1 inline h-3 w-3" />
                        Plaintext link
                      </Chip>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted">{entry.description}</p>
                  <p className="mt-1 text-xs text-accent">{entry.matchReason}</p>
                </div>
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-9 shrink-0 items-center gap-1 text-sm text-accent no-underline hover:underline"
                >
                  Open the docs
                  <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Exercises:</span>
                {entry.skillIds.map((id) => (
                  <Link key={id} to={`/skills/${id}`} className="gm-chip inline-flex min-h-9 items-center gap-1 px-2.5 text-sm no-underline">
                    {SKILL_OPTIONS.find((skill) => skill.id === id)?.name ?? id.replace(/^skill:/, '').replace(/-/g, ' ')}
                  </Link>
                ))}
              </div>
            </Card>
          )
        })}
      </Stagger>

      <div className="mt-6">
        <Card>
          <SectionTitle hint={`${provenance.directory} · ${provenance.licence}`}>What this list cannot tell you</SectionTitle>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            {provenance.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Descriptions are quoted verbatim from upstream (truncated), and the link column is reproduced unchanged so you can
            always go and check the original row. The whole list is in the repository at
            <code className="mx-1 rounded bg-[var(--gm-surface-2)] px-1">src/data/publicApis/catalog.generated.ts</code>
            — generated, with the commit it came from in its header.
          </p>
        </Card>
      </div>
    </div>
  )
}
