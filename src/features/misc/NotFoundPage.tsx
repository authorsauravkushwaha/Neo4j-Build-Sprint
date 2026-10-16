/** 404: offer the real destinations rather than a dead end. */
import type { ReactNode } from 'react'
import { Compass, GitBranch, Home, Map } from 'lucide-react'

import { Card, LinkButton, PageHeader, SectionTitle } from '@/components/ui.tsx'

const DESTINATIONS = [
  { to: '/', label: 'Dashboard', hint: 'Your current plan and next actions', icon: Home },
  { to: '/careers', label: 'Explore careers', hint: 'All curated directions with their skills', icon: Compass },
  { to: '/graph', label: 'Knowledge graph', hint: 'See how skills depend on each other', icon: GitBranch },
  { to: '/roadmap', label: 'Your roadmap', hint: 'Week-by-week learning plan', icon: Map },
]

export function NotFoundPage(): ReactNode {
  return (
    <div>
      <PageHeader
        eyebrow="404"
        title="That page does not exist"
        description="The link may be out of date, or the item it pointed at was removed. Nothing is broken — pick a destination below."
      />
      <Card>
        <SectionTitle hint="most useful pages">Where to go instead</SectionTitle>
        <ul className="grid gap-2 sm:grid-cols-2">
          {DESTINATIONS.map(({ to, label, hint, icon: Icon }) => (
            <li key={to}>
              <LinkButton to={to} variant="secondary" className="w-full justify-start" icon={<Icon className="h-4 w-4" />}>
                <span className="flex flex-col items-start">
                  <span>{label}</span>
                  <span className="text-xs font-normal text-muted">{hint}</span>
                </span>
              </LinkButton>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}


