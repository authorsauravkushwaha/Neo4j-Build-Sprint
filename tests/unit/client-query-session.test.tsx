/**
 * The data pages must not answer with the bundled sample dataset while a live
 * backend is still being confirmed.
 *
 * The session probe runs in the background, so `api()` is the demo client for
 * the first moments of the app's life. A query that runs in that window
 * returns sample data even though the live backend is about to answer — the
 * page would show demo data next to a working backend, and only the banner
 * would tell the truth. These tests pin the behaviour: the query waits for
 * the session, and it runs again when the client itself changes.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useClientQuery } from '@/features/shared/hooks.ts'
import type { ClientResult } from '@/core/api.ts'

const session = vi.hoisted(() => {
  const listeners = new Set<(next: { ready: boolean; client: unknown }) => void>()
  return {
    listeners,
    state: { ready: false, client: null as unknown },
    publish(next: { ready: boolean; client: unknown }): void {
      session.state = next
      for (const listener of session.listeners) listener(next)
    },
  }
})

vi.mock('@/core/session.ts', () => ({
  api: () => ({}),
  sessionState: () => session.state,
  subscribeSession: (listener: (next: { ready: boolean; client: unknown }) => void) => {
    session.listeners.add(listener)
    listener(session.state)
    return () => session.listeners.delete(listener)
  },
}))

function Probe({ run }: { run: () => Promise<ClientResult<string>> }): React.ReactNode {
  const query = useClientQuery(run, [], 'probe')
  useEffect(() => {
    if (query.status === 'ready') void document.body.setAttribute('data-probe', String(query.data))
  }, [query.status, query.data])
  return <p role="status">{query.status}</p>
}

describe('useClientQuery', () => {
  beforeEach(() => {
    session.listeners.clear()
    session.state = { ready: false, client: null }
    document.body.removeAttribute('data-probe')
  })

  it('does not run the query before the session has answered', async () => {
    const run = vi.fn().mockResolvedValue({ data: 'live', meta: { source: 'local-sample', generatedAt: '2026-10-17T00:00:00.000Z' } })
    render(<Probe run={run} />)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(run).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('loading')
  })

  it('runs the query with the live client once the session is ready', async () => {
    const run = vi.fn().mockResolvedValue({ data: 'live', meta: { source: 'local-sample', generatedAt: '2026-10-17T00:00:00.000Z' } })
    render(<Probe run={run} />)

    await act(async () => {
      session.publish({ ready: true, client: { id: 'live' } })
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('ready'))
  })

  it('runs the query again when the client changes', async () => {
    const run = vi.fn().mockResolvedValue({ data: 'live', meta: { source: 'local-sample', generatedAt: '2026-10-17T00:00:00.000Z' } })
    render(<Probe run={run} />)

    await act(async () => {
      session.publish({ ready: true, client: { id: 'live' } })
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    await act(async () => {
      session.publish({ ready: true, client: { id: 'fallback' } })
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  })

  it('still runs the query when the session never answers', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn().mockResolvedValue({ data: 'demo', meta: { source: 'local-sample', generatedAt: '2026-10-17T00:00:00.000Z' } })
      render(<Probe run={run} />)

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
