/**
 * "Share / copy link" button for detail pages.
 *
 * Careers and skills are the pages a learner actually sends to a friend or a
 * mentor, so they get a first-class share action instead of relying on the
 * browser chrome. The result is reported from what really happened
 * (`share.ts`), never assumed.
 */
import type { ReactNode } from 'react'
import { Share2 } from 'lucide-react'

import { Button } from '@/components/ui.tsx'
import { shareLink } from '@/core/share.ts'
import { useAppStore } from '@/state/store.ts'

export function ShareButton({ title }: { title: string }): ReactNode {
  const pushToast = useAppStore((state) => state.pushToast)
  return (
    <Button
      variant="secondary"
      icon={<Share2 className="h-4 w-4" />}
      onClick={() => {
        void shareLink({ title, url: window.location.href }).then((outcome) => {
          if (outcome === 'copied') pushToast({ kind: 'success', message: 'Link copied.', detail: 'Anyone opening it lands on this page.' })
          else if (outcome === 'failed') pushToast({ kind: 'warning', message: 'Could not copy the link.', detail: 'Copy it from the address bar instead.' })
        })
      }}
    >
      Share
    </Button>
  )
}


