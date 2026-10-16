// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { accountsPlugin } from '../../server/vite.ts'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  db: { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => {}) },
}))
vi.mock('../../server/database.ts', () => ({ openDatabase: mocks.open }))
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => { vi.clearAllMocks(); mocks.open.mockResolvedValue(mocks.db) })
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function attach(env: Record<string, string> = {}) {
  const plugin = accountsPlugin({ GM_DATABASE_DIR: 'vite-lifecycle-test', ...env })
  const close = plugin.closeBundle as () => Promise<void>
  cleanup.push(close)
  const http = new EventEmitter()
  const use = vi.fn()
  await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
    httpServer: http, middlewares: { use }, config: { logger: { info: vi.fn() } },
  } as unknown as ViteDevServer)
  return { close, http, use }
}

describe('Vite database lifecycle', () => {
  it('shares one engine while Vite creates the replacement before closing the old server', async () => {
    const old = await attach()
    const replacement = await attach()
    expect(mocks.open).toHaveBeenCalledTimes(1)
    old.http.emit('close')
    await old.close()
    expect(mocks.db.end).not.toHaveBeenCalled()
    await replacement.close()
    expect(mocks.db.end).toHaveBeenCalledTimes(1)
    replacement.http.emit('close')
    await replacement.close()
    expect(mocks.db.end).toHaveBeenCalledTimes(1)
  })

  it('releases a closed engine and opens a new one for the next server', async () => {
    const first = await attach()
    await first.close()
    const second = await attach()
    expect(mocks.open).toHaveBeenCalledTimes(2)
    await second.close()
    expect(mocks.db.end).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed startup or open storage in external API mode', async () => {
    mocks.open.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(attach()).rejects.toThrow('storage unavailable')
    const healthy = await attach()
    expect(mocks.open).toHaveBeenCalledTimes(2)
    await healthy.close()
    await attach({ GM_EXTERNAL_API: 'true' })
    expect(mocks.open).toHaveBeenCalledTimes(2)
  })
})
