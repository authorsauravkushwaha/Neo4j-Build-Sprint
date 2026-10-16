/**
 * Palette search — the ranking behind Cmd/Ctrl+K.
 *
 * Why a hand-written ranker instead of a fuzzy-search dependency: the index is
 * small (every page, career, skill, project and resource the app can enumerate)
 * and the ranking has to be *explainable*. A learner typing "pid" should get
 * the PID control skill before a resource that merely mentions it, and nobody
 * should ever wonder why an entry matched. So the score is a short, ordered
 * list of match classes — exact, prefix, word-start, substring, subsequence —
 * with no hidden weights and no randomness.
 *
 * The rules, in order of strength (a title match always beats a body match):
 *
 *   exact title            1000  "PID control" typed in full
 *   title starts with      800   "pid" → "PID control"
 *   a title word starts    600   "control" → "PID control"
 *   title contains         400   "ontro" → "PID control"
 *   keyword/subtitle word  250   entries carry the skill ids they cover
 *   keyword/subtitle has   150
 *
 * Shorter titles win ties, so "PID control" outranks "PID control with MATLAB"
 * for the query "pid control". No match returns -1, and `rankEntries` drops
 * those entries entirely — an empty result list is honest, rather than a list
 * of things that "kinda" matched.
 *
 * A subsequence class ("pdc" → "PID control") was tried and **removed**: over
 * this index it matched "pid" to "Supervised learning" and "Career pathway
 * builder", because the letters appear in order inside two ordinary words. The
 * out-of-order noise was worse than the convenience it bought, and it was found
 * by typing into the palette in a real browser rather than by reading the code.
 */

export type PaletteKind = 'Page' | 'Career' | 'Skill' | 'Project' | 'Resource'

export interface PaletteEntry {
  id: string
  kind: PaletteKind
  title: string
  subtitle?: string
  /** Where selecting the entry navigates. */
  to: string
  /** Extra terms that should find this entry (ids, provider names, tools). */
  keywords?: string[]
}

export interface PaletteGroup {
  kind: PaletteKind
  label: string
  items: PaletteEntry[]
  /** Score of this group's best hit — used to order the groups, not shown. */
  best?: number
}

/** Group order in the list: navigation first, then the learning material. */
export const KIND_ORDER: PaletteKind[] = ['Page', 'Career', 'Skill', 'Project', 'Resource']

export const KIND_LABEL: Record<PaletteKind, string> = {
  Page: 'Go to',
  Career: 'Careers',
  Skill: 'Skills and concepts',
  Project: 'Projects',
  Resource: 'Resources',
}

/** Lowercases and strips accents so "matlab" finds "MATLAB" and "kicad" finds "KiCad". */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function wordStarts(text: string, query: string): boolean {
  return text.split(/[^a-z0-9+#.]+/).some((word) => word.length > 0 && word.startsWith(query))
}

function bodyStarts(text: string, query: string): boolean {
  return text.startsWith(query) || wordStarts(text, query)
}

/**
 * Score one entry against a query. Returns -1 when it does not match at all.
 * Exported for tests: the ranking is a product decision, so it is pinned.
 */
export function scoreEntry(query: string, entry: PaletteEntry): number {
  const term = normalise(query)
  if (term.length === 0) return 0
  const title = normalise(entry.title)

  let base = -1
  if (title === term) base = 1000
  else if (title.startsWith(term)) base = 800
  else if (wordStarts(title, term)) base = 600
  else if (title.includes(term)) base = 400

  if (base === -1) {
    const bodies = [entry.subtitle ?? '', ...(entry.keywords ?? [])].map(normalise).filter((text) => text.length > 0)
    if (bodies.some((text) => bodyStarts(text, term))) base = 250
    else if (bodies.some((text) => text.includes(term))) base = 150
    else return -1
  }

  // Tie-break towards the shorter, more specific title.
  return base - Math.min(40, entry.title.length / 4)
}

/**
 * Rank every entry, drop the ones that do not match, and group the rest.
 *
 * An empty query keeps the entries in the order the caller supplied them (the
 * palette passes pages first), so a freshly opened palette offers navigation
 * rather than dumping the whole dataset before the user has typed anything.
 */
export function rankEntries(
  entries: PaletteEntry[],
  query: string,
  options: { perGroup?: number; total?: number } = {},
): PaletteGroup[] {
  const perGroup = options.perGroup ?? 6
  const total = options.total ?? 24

  const scored = entries
    .map((entry, position) => ({ entry, score: scoreEntry(query, entry), position }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, total)

  const groups: Array<PaletteGroup & { best: number }> = []
  for (const kind of KIND_ORDER) {
    const hits = scored.filter((item) => item.entry.kind === kind)
    if (hits.length === 0) continue
    groups.push({ kind, label: KIND_LABEL[kind], items: hits.slice(0, perGroup).map((hit) => hit.entry), best: hits[0]?.score ?? 0 })
  }

  /* Order groups by their strongest hit, with the fixed kind ladder as the
     tie-break. Pinning "Pages" to the top regardless of score put "Career
     pathway builder" above "PID control" for the query "pid" — the grouping
     must never outrank the match. */
  return groups
    .sort((a, b) => b.best - a.best || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map(({ kind, label, items }) => ({ kind, label, items }))
}


