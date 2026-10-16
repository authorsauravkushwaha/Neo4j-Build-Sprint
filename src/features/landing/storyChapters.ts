/**
 * The story's chapters.
 *
 * One list, three consumers: the chapter bar that navigates, the scroll-spy that
 * highlights the current one, and the tests that check every link in it lands on
 * something. Keeping them in one place is what stops the bar drifting out of
 * sync with the page — a nav entry pointing at a section that was renamed is the
 * most common way a long page rots.
 *
 * Order here is reading order. The ids must exist as elements on the landing
 * page; `tests/unit/story.test.ts` renders the page and fails if one does not.
 */
import type { ScrollSpyEntry } from '@/skiper/components/ScrollRail.tsx'

export const storyChapters: readonly ScrollSpyEntry[] = [
  { id: 'why', label: 'Why a list fails' },
  { id: 'graph', label: 'The graph' },
  { id: 'answer', label: 'What comes back' },
  { id: 'worked', label: 'Worked example' },
  { id: 'careers', label: 'Careers' },
  { id: 'platform', label: 'What it is built on' },
  { id: 'limits', label: 'Limits' },
  { id: 'security', label: 'Security' },
  { id: 'next', label: 'Next step' },
] as const
