/**
 * Recently viewed careers and skills.
 *
 * Two promises: the list is a small, honest convenience (newest first,
 * de-duplicated, capped), and it is treated like every other piece of guest
 * data — hand-edited storage cannot crash the reader, export includes it,
 * and erase removes it. If either stops being true, the dashboard would be
 * showing a history the privacy page claims does not outlive the device.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { eraseAll, exportAll, loadRecentViews, recordRecentView, STORAGE_KEYS } from '@/core/persistence.ts'

beforeEach(() => {
  window.localStorage.clear()
})

describe('recordRecentView', () => {
  it('keeps newest first and de-duplicates by route', () => {
    recordRecentView({ to: '/careers/career:a', name: 'A', kind: 'Career' })
    recordRecentView({ to: '/skills/skill:b', name: 'B', kind: 'Skill' })
    recordRecentView({ to: '/careers/career:a', name: 'A', kind: 'Career' })

    const views = loadRecentViews()
    expect(views.map((view) => view.to)).toEqual(['/careers/career:a', '/skills/skill:b'])
    expect(views[0]?.viewedAt).toBeTruthy()
  })

  it('caps the list so it stays a convenience, not a history', () => {
    for (let index = 0; index < 12; index += 1) {
      recordRecentView({ to: `/careers/career:${index}`, name: `Career ${index}`, kind: 'Career' })
    }
    expect(loadRecentViews()).toHaveLength(8)
    expect(loadRecentViews()[0]?.to).toBe('/careers/career:11')
  })

  it('ignores malformed stored entries instead of crashing', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.recent,
      JSON.stringify([{ to: '/careers/career:a', name: 'A', kind: 'Career', viewedAt: 'now' }, { nope: true }, 'junk', null]),
    )
    expect(loadRecentViews()).toHaveLength(1)
    window.localStorage.setItem(STORAGE_KEYS.recent, '{not json')
    expect(loadRecentViews()).toEqual([])
  })

  it('is exported and erased with everything else', () => {
    recordRecentView({ to: '/skills/skill:a', name: 'A', kind: 'Skill' })
    const exported = exportAll() as { recentViews?: unknown[] }
    expect(exported.recentViews).toHaveLength(1)

    const removed = eraseAll()
    expect(removed).toContain(STORAGE_KEYS.recent)
    expect(loadRecentViews()).toEqual([])
  })
})


