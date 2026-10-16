/**
 * Privacy and terms template.
 *
 * This is a starting template, not legal advice, and the page says so. It is
 * written to describe exactly what the code does — if the code changes, this
 * file has to change with it.
 */
import type { ReactNode } from 'react'

import { Callout, Card, Grid, LinkButton, List, PageHeader, SectionTitle } from '@/components/ui.tsx'
import { hasBackend } from '@/core/env.ts'

export function PrivacyPage(): ReactNode {
  return (
    <div>
      <PageHeader
        eyebrow="Privacy and terms"
        title="What is collected, where it goes, and what you agree to"
        description="Plain-language template. It describes the behaviour of this application; it is not legal advice and should be reviewed before any public launch."
        actions={
          <LinkButton to="/about" variant="secondary">
            Features and limitations
          </LinkButton>
        }
      />

      <Callout kind="warning" title="Template notice">
        Replace the operator name, contact address and jurisdiction below before publishing this app. Nothing in this document
        creates a guarantee of employment, income or admission to any programme.
      </Callout>

      <div className="mt-5 grid gap-4">
        <Card>
          <SectionTitle hint="short version, first">Summary</SectionTitle>
          <List
            items={[
              'No account is required. Guest mode stores everything in your browser only.',
              'No analytics, no advertising, no tracking pixels, no session recording, no third-party fonts.',
              'We do not sell data, and there is no data to sell: careers, skills and resources come from a bundled curriculum dataset.',
              'You can export and erase everything from Settings at any time.',
              'Mentor conversations are not written to a database by default.',
            ]}
          />
        </Card>

        <Grid cols={2}>
          <Card>
            <SectionTitle hint="stored in your browser">What your device holds</SectionTitle>
            <List
              items={[
                'Onboarding answers, study preferences, theme and accessibility settings.',
                'Self-reported skill levels and self-check results, roadmap task statuses, logged hours, bookmarks and feedback drafts.',
                'A pseudonymous local profile id used only to scope your own records.',
                'Nothing in local storage is a secret: it holds no tokens, no passwords and no API keys, so an XSS bug cannot steal credentials from here.',
                'Because it is local, it is visible to anyone with access to this browser profile. Erase it in Settings when using a shared computer.',
              ]}
            />
          </Card>

          <Card>
            <SectionTitle hint={hasBackend ? 'only when you sign in' : 'not applicable in this build'}>What an account would store</SectionTitle>
            <List
              items={[
                'Your email address, only if you choose to sign in. Sign in with a one-time email link or a password — either way this app never stores the password; the identity provider hashes it.',
                'A session token in this browser’s local storage (key gm.auth) while you stay signed in. It is a credential: signing out clears it, and “sign out everywhere” revokes it on the server.',
                'The same preferences and progress as above, so a plan can continue on another device, plus saved roadmaps and their task rows.',
                'Feedback you explicitly submit, with the page you submitted it from and the app version, so bugs can be reproduced.',
                'Records are confined to your own account id by row-level security in the database; server-side jobs never merge accounts.',
                'Sign-in attempts are counted per address (hashed in your browser first, so the counter cannot read it) and per network, to slow down password guessing. Those counters expire within the hour.',
              ]}
            />
          </Card>

          <Card>
            <SectionTitle hint="who processes what">Third parties</SectionTitle>
            <List
              items={[
                'Supabase hosts the authentication, database and Edge Functions when that backend is configured; a self-hosted deployment instead serves accounts and the graph from the operator’s own PostgreSQL on the same machine. The respective host’s privacy terms apply.',
                'The public curriculum graph is stored either in Neo4j AuraDB or in the deployment’s own PostgreSQL database, depending on the backend. It receives no personal data — queries are parameterised and read-only.',
                'An AI provider (Google Gemini or any OpenAI-compatible endpoint) receives the mentor question and the small graph excerpt needed to answer it, only if the operator configures a key. If no key is configured, nothing leaves the server: the rules engine answers instead.',
                'Resources link out to external sites. Those sites have their own privacy practices; this app sends no identifying information in the link.',
              ]}
            />
          </Card>

          <Card>
            <SectionTitle hint="retention">How long things are kept</SectionTitle>
            <List
              items={[
                'Local data: until you erase it, or until your browser clears it.',
                'Account data: until you delete it in Settings. Deletion is immediate for roadmaps, tasks, ratings, bookmarks and feedback rows.',
                'Rate-limit and nonce records: short-lived rows (minutes to hours) used to stop abuse and replay. They contain a hash of the identity and a counter, not message content.',
                'Mentor conversations: held in the browser tab’s memory for the session and cleared on reload. They are not persisted server-side.',
                'Server logs, if an operator enables them, may retain request metadata (path, status, duration) — configure retention and state it here before launch.',
              ]}
            />
          </Card>
        </Grid>

        <Card>
          <SectionTitle hint="not a substitute for legal review">Terms of use (template)</SectionTitle>
          <div className="space-y-3 text-sm">
            <p>
              <strong>Educational guidance only.</strong> GraphMentor AI produces study suggestions, skill-gap estimates and learning
              plans. It is an educational tool. It does not provide professional engineering advice, and it is not a substitute for
              supervision, certification or local regulations in any discipline.
            </p>
            <p>
              <strong>No outcome guarantees.</strong> The app makes no promise of interviews, employment, salary, admission, visa
              eligibility or any other outcome. Effort, market conditions and factors outside this app determine results.
            </p>
            <p>
              <strong>You keep your content.</strong> Your ratings, notes, bookmarks and answers remain yours. By sending a mentor
              question you allow the operator to process it to produce an answer, nothing more.
            </p>
            <p>
              <strong>Acceptable use.</strong> Do not attempt to overload, scrape at high volume, bypass rate limits, attack the API
              or probe other users’ data. Abuse protections exist and are enforced server-side; requests are rate-limited per identity
              and per IP.
            </p>
            <p>
              <strong>Safety.</strong> Hardware, electrical, chemical and structural projects need proper supervision, appropriate
              protective equipment and compliance with local codes. Where the app flags a hazard, that is a prompt to seek qualified
              supervision, not a complete safety analysis.
            </p>
            <p>
              <strong>Accuracy and changes.</strong> Skills, prerequisites and resource access models change over time. Every resource
              carries a last-checked date, and the app prefers to say "unknown" rather than guess. This document and the app may change;
              material changes will be noted in the repository history.
            </p>
            <p>
              <strong>Contact.</strong> Replace with the operator’s real contact address before publishing, for example
              privacy@example.com. Include the jurisdiction whose law applies if required where you operate.
            </p>
          </div>
        </Card>

        <Callout kind="info" title="Exceptions we do not hide">
          A database operator can technically read rows they host, and law-enforcement requests can compel disclosure. This app is
          designed so that the sensitive surface is as small as possible: no message content stored by default, no credentials in the
          browser, and deletion that actually removes rows rather than flagging them.
        </Callout>
      </div>
    </div>
  )
}


