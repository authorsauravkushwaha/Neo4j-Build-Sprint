/**
 * The mentor page shows its work.
 *
 * Two claims are made about this screen and both are checked here against the real
 * page running the real client in demo mode:
 *
 *   1. **Answers are grounded.** A question that names something in the graph
 *      produces an answer, and the answer carries a read ledger naming the queries
 *      that produced it — so a reader can audit the grounding rather than trust it.
 *   2. **Ungrounded answers say so.** A question that matches nothing gets the
 *      honest note and an empty ledger, instead of an arbitrary slice of the
 *      catalogue dressed up as advice.
 *
 * The ledger is the part that cannot be faked by accident: it is built from the
 * reader layer's own return values, so it reports what the code actually queried,
 * including the queries that found nothing.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { MentorPage } from '@/features/mentor/MentorPage.tsx'

function renderMentor(path = '/mentor') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/mentor" element={<MentorPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function askQuestion(question: string) {
  const user = userEvent.setup()
  renderMentor()
  await user.type(await screen.findByLabelText(/your question/i), question)
  await user.click(screen.getByRole('button', { name: /^ask$/i }))
  return user
}

describe('mentor page: grounded answers and their read ledger', () => {
  it('answers a question that names a skill and lists the graph reads behind it', async () => {
    await askQuestion('Why do I need mathematics before machine learning?')

    // The ledger disclosure, with a non-zero read count. Waiting on this is also
    // waiting on the answer: the ledger is computed while the answer is composed.
    const summary = await screen.findByText(/graph reads \(\d+\)/i, {}, { timeout: 8000 })
    const declared = Number(/\((\d+)\)/.exec(summary.textContent ?? '')?.[1] ?? '0')
    expect(declared).toBeGreaterThan(0)

    // …a table of reader methods, one line each…
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    // Header row plus one line per reader method.
    expect(rows.length).toBe(declared + 1)

    // …and at least one line naming a real GraphReader method, with a row count.
    const body = rows.slice(1).map((row) => row.textContent ?? '')
    expect(body.some((line) => /get|list|find/.test(line))).toBe(true)
    expect(body.some((line) => /\d/.test(line))).toBe(true)

    // And there is an answer body, not just provenance around nothing.
    const answer = document.querySelector('.whitespace-pre-wrap')
    expect((answer?.textContent ?? '').trim().length).toBeGreaterThan(40)
  })

  it('states that answers are written from those reads and nothing else', async () => {
    await askQuestion('Which skills am I missing for an embedded role?')
    await waitFor(() => expect(screen.getByText(/graph reads \(\d+\)/i)).toBeInTheDocument(), { timeout: 8000 })

    expect(screen.getByText(/and nothing else\. Nothing was looked up outside this list\./i)).toBeInTheDocument()
  })

  it('says so plainly when a question could not be grounded in the graph', async () => {
    await askQuestion('qwertyuiop zxcvbnm flibbertigibbet')

    await waitFor(() => expect(screen.getByText(/graph reads \(0\)/i)).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.getByText(/not grounded in the curriculum/i)).toBeInTheDocument()
    // No fabricated table of reads, and no catalogue recommendations either.
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a suggestion chip answers without typing, and the answer is still ledgered', async () => {
    const user = userEvent.setup()
    renderMentor()
    await user.click(await screen.findByRole('button', { name: /why do i need mathematics before machine learning\?/i }))

    await waitFor(() => expect(screen.getByText(/graph reads \([1-9]\d*\)/i)).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.getByText(/graph reads \([1-9]\d*\)/i)).toBeInTheDocument()
  })
})
