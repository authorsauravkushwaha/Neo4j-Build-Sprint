/**
 * The workflow page.
 *
 * What is being checked here is not "does the button work" — it is that a person
 * reading this page cannot come away believing something the engine did not do:
 * that a skipped node succeeded, that a dry run wrote a record, that the
 * workflow's own limits are someone else's problem, or that a workflow was
 * executed on a server somewhere.
 *
 * The runs use the demo client against the bundled curriculum, which is exactly
 * what a visitor with no backend gets.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { WorkflowsPage } from '@/features/workflows/WorkflowsPage.tsx'
import { WORKFLOW_LIBRARY } from '@core/workflow/library.ts'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/workflows']}>
      <WorkflowsPage />
    </MemoryRouter>,
  )
}

describe('the workflow page', () => {
  it('lists every workflow in the library with its step count and trigger', () => {
    renderPage()
    for (const definition of WORKFLOW_LIBRARY) {
      expect(screen.getByRole('heading', { name: definition.name })).toBeInTheDocument()
    }
    // The scheduled one says so in words, not only as a cron expression.
    expect(screen.getByText(/minute 0 of hour 06:00, every Monday/)).toBeInTheDocument()
    expect(screen.getAllByText(/steps/).length).toBeGreaterThanOrEqual(WORKFLOW_LIBRARY.length)
  })

  it('says where a run happens rather than implying a background service', () => {
    renderPage()
    expect(screen.getByText(/Running against the bundled curriculum in this tab/i)).toBeInTheDocument()
    expect(screen.getByText(/Nothing runs it automatically in this deployment/i)).toBeInTheDocument()
  })

  it('opens each workflow s own limitations, because they are part of the feature', async () => {
    const user = userEvent.setup()
    renderPage()
    const toggles = screen.getAllByRole('button', { name: /What this workflow cannot do/i })
    expect(toggles).toHaveLength(WORKFLOW_LIBRARY.length)
    await user.click(toggles[0]!)
    const first = WORKFLOW_LIBRARY[0]!
    for (const limitation of first.limitations) {
      expect(await screen.findByText(limitation)).toBeInTheDocument()
    }
  })

  it('runs a workflow and logs every node, including the one it skipped in a dry run', async () => {
    const user = userEvent.setup()
    renderPage()
    const sweep = screen.getByRole('heading', { name: 'Resource freshness sweep' }).closest('section')!
    await user.click(within(sweep).getByRole('button', { name: 'Dry run' }))

    const log = await within(sweep).findByTestId('workflow-run', {}, { timeout: 15000 })
    // Every step appears, in order, by name.
    for (const node of WORKFLOW_LIBRARY[0]!.nodes) {
      expect(within(log).getByText(new RegExp(node.name))).toBeInTheDocument()
    }
    // The probe is skipped in a dry run and the log says why, in the node row.
    expect(within(log).getAllByText('skipped').length).toBeGreaterThan(0)
    expect(within(log).getByText(/dry run: no requests were made/i)).toBeInTheDocument()
    // The caveats block carries the workflow's own limits plus the engine's.
    expect(within(log).getByText(/What this run could not do/i)).toBeInTheDocument()
    expect(within(log).getByText(/It records findings; it never edits the curriculum/i)).toBeInTheDocument()
    // Nothing was written, and the page says so by not listing records.
    expect(within(sweep).queryByText(/Record\(s\)/i)).toBeNull()
  }, 20000)

  it('reports the data source for the run it just performed', async () => {
    const user = userEvent.setup()
    renderPage()
    const digest = screen.getByRole('heading', { name: 'Weekly plan digest' }).closest('section')!
    await user.click(within(digest).getByRole('button', { name: 'Run' }))
    const log = await within(digest).findByTestId('workflow-run', {}, { timeout: 15000 })
    expect(within(log).getByText(/reading/i)).toBeInTheDocument()
    expect(within(log).getByText('bundled-sample')).toBeInTheDocument()
    expect(within(log).getByText(/8 node\(s\)|5 node\(s\)/)).toBeInTheDocument()
  }, 20000)

  it('offers the n8n document for review and says what it is for', () => {
    renderPage()
    const buttons = screen.getAllByRole('button', { name: /Download .* as an n8n document/i })
    expect(buttons).toHaveLength(WORKFLOW_LIBRARY.length)
    // No download silently starts: each one is an explicit control with a name.
    expect(buttons[0]!.getAttribute('aria-label')).toMatch(/n8n document/)
  })

  it('does not claim to be a no-code builder it is not', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: /add node/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new workflow/i })).toBeNull()
  })
})
