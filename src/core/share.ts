/**
 * Sharing a page link.
 *
 * Uses the Web Share API where the browser offers it (mostly mobile), and
 * falls back to the clipboard. Returns how it went so the caller can say
 * something true in a toast — "link copied" is only claimed when the copy
 * actually happened. Nothing is tracked: no share analytics, no third-party
 * share widgets, no URL parameters added.
 */
export type ShareOutcome = 'shared' | 'copied' | 'failed'

/** Copy plain text (a mentor answer, a citation list). True only if it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function shareLink(input: { title: string; url: string }): Promise<ShareOutcome> {
  const nav = navigator as Navigator & {
    share?: (data: { title: string; url: string }) => Promise<void>
    clipboard?: { writeText(text: string): Promise<void> }
  }
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: input.title, url: input.url })
      return 'shared'
    } catch {
      // The user dismissed the share sheet, or the browser refused. Either
      // way, quietly fall through to the clipboard rather than claiming
      // anything happened.
    }
  }
  if (nav.clipboard) {
    try {
      await nav.clipboard.writeText(input.url)
      return 'copied'
    } catch {
      return 'failed'
    }
  }
  return 'failed'
}


