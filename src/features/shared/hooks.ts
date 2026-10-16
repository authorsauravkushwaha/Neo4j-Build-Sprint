/**
 * Data-loading hooks shared by the feature pages.
 *
 * `useClientQuery` is deliberately tiny: it runs an async client call, tracks
 * loading/error state, and cancels via AbortController when the inputs change or
 * the component unmounts. Errors are surfaced as messages the user can act on
 * (which source failed, what to try) rather than as raw stack traces.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ApiError, type ClientResult } from '@/core/api.ts'
import { api } from '@/core/session.ts'

export interface QueryState<T> {
  status: 'loading' | 'ready' | 'error'
  data: T | null
  meta: ClientResult<T>['meta'] | null
  error: { message: string; detail?: string; code?: string } | null
  reload: () => void
}

export function useClientQuery<T>(run: () => Promise<ClientResult<T>>, deps: unknown[], label = 'data'): QueryState<T> {
  const [state, setState] = useState<Omit<QueryState<T>, 'reload'>>({ status: 'loading', data: null, meta: null, error: null })
  const [nonce, setNonce] = useState(0)
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    let cancelled = false
    setState((previous) => ({ ...previous, status: previous.data ? previous.status : 'loading', error: null }))
    runRef
      .current()
      .then((result) => {
        if (cancelled) return
        setState({ status: 'ready', data: result.data, meta: result.meta, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const apiError = error instanceof ApiError ? error : null
        setState({
          status: 'error',
          data: null,
          meta: null,
          error: {
            message: apiError ? apiError.message : `Could not load ${label}.`,
            ...(apiError?.code ? { code: apiError.code } : {}),
            detail:
              apiError?.code === 'not_configured'
                ? 'The backend has no knowledge graph configured. Everything still works with the bundled sample dataset.'
                : apiError?.code === 'rate_limited'
                  ? `Too many requests. ${apiError.retryAfterSeconds ? `Try again in ${apiError.retryAfterSeconds}s.` : 'Please wait a moment.'}`
                  : apiError?.code === 'network_error'
                    ? 'The request never reached the server.'
                    : undefined,
          },
        })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { ...state, reload }
}

/** True while the app is running on the bundled sample dataset. */
export function useIsDemo(): boolean {
  const [demo, setDemo] = useState(api().mode === 'demo')
  useEffect(() => {
    // The session probe can finish after the first render; re-check cheaply.
    const timer = window.setInterval(() => setDemo(api().mode === 'demo'), 1500)
    return () => window.clearInterval(timer)
  }, [])
  return demo
}

export interface CareerSelection {
  careerId: string | null
  setCareerId: (id: string | null) => void
}

/**
 * A text filter stored in the URL (`?q=…`), not in component state.
 *
 * Two reasons this matters for real use: a filtered library or project list can
 * be bookmarked, shared or sent to another device and it opens the same way, and
 * the selection survives a reload. Writes go through a single `setSearchParams`
 * call — two calls in one handler do not compose, the second rebuilds the URL
 * from the pre-navigation params and erases the first (a real bug this codebase
 * hit once and now avoids everywhere).
 */
export function useTextParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? ''
  const setValue = useCallback(
    (next: string) => {
      const updated = new URLSearchParams(params)
      if (next) updated.set(key, next)
      else updated.delete(key)
      setParams(updated, { replace: true })
    },
    [key, params, setParams],
  )
  return [value, setValue]
}

/** Reads `?career=` from the URL so links between screens keep the context. */
export function useCareerParam(fallback?: (first: string | null) => void): CareerSelection {
  const [params, setParams] = useSearchParams()
  const careerId = params.get('career')
  const setCareerId = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params)
      if (id) next.set('career', id)
      else next.delete('career')
      setParams(next, { replace: true })
    },
    [params, setParams],
  )
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (careerId && reported.current === careerId) return
    if (!careerId && fallback) {
      reported.current = null
      fallback(null)
    }
  }, [careerId, fallback])
  return useMemo(() => ({ careerId, setCareerId }), [careerId, setCareerId])
}


