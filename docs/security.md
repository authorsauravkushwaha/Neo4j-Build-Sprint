# Security design

Security here is a set of implemented, tested controls — not a checklist in a README. Each section says
what is defended, where the code lives, how it is tested, and **what it does not cover**.

Run the evidence yourself:

```bash
npm test                       # 613 tests, 40 files — security (46), hardening invariants (28),
                               # input validation (27), store authorization (17), auth (17), handlers (43),
                               # workflow engine (56), appwrite adapter (41), recommendation (31), import pipeline (6),
                               # persistence (25), frontier (25), rate limiting (10), scroll coverage (8),
                               # scroll chrome (10), docs references (3), and the rest
npm run verify                 # all of it in one command, naming any step it had to skip
npm run oracle                 # recomputes the skill-gap frontier in Java and diffs it line by line
npm run lint:secrets           # fails on credential-shaped strings in the source and the built bundle
npm audit --omit=dev           # shipped dependency tree
npm run validate:seed          # refuses to emit Cypher containing credential shapes
```

Want the short version? Section 13 maps each named threat to its control, its file and the test that
proves it. Everything before that explains the reasoning.

---

## 1. Trust boundaries

```
Browser / Android WebView            Supabase Edge Functions                 Data stores
────────────────────────             ────────────────────────                ───────────
holds: preferences, self-reported    holds: Neo4j URL + password, AI keys,   Neo4j AuraDB
       skill states, progress,              service_role key, signing secret  Supabase Postgres
       bookmarks
                                       ↑ every request is authenticated,
never holds: any credential                   authorized and rate limited
```

- The browser **never** talks to Neo4j. Credentials for it exist only as Edge Function secrets
  (`supabase/.env.example` documents each one).
- The only key in the frontend bundle is the Supabase **anon** key, which is safe *only* because every
  table has row-level security. The `service_role` key is server-side only, and `npm run lint:secrets`
  fails the build if a key-shaped string is ever committed.
- `src/core/api.ts` has no code path that falls back from "live" to "sample" silently: if the backend is
  unreachable the UI says so and offers demo mode as a choice.

## 2. Authentication vs authorization

**Authentication** is Supabase Auth: email + password (PKCE), or a single-use emailed link. **Authorization
is never inferred from it.** A signed-in user is still a stranger until a handler says what they may touch:

- Every write handler resolves the user itself (`requireUser`) and then operates **scoped to that user id**.
  A valid token belonging to user B cannot read, update or delete user A's rows.
- Ownership is enforced twice: in the handler (explicit `user_id` filter) and in PostgreSQL via RLS
  (`auth.uid() = user_id` on every private table). The handler check is the testable one; RLS is the one
  that survives a handler bug.
- `update-progress` addresses rows by their own uuid, so a client cannot mark someone else's task complete
  by guessing a skill id. The integration suite asserts this with two accounts.
- Tests: `tests/integration/handlers.test.ts` → *"scopes stored rows to the caller, so one user cannot read
  another's plan"*, *"refuses to update a task that belongs to another account"*, *"exports and deletes only
  the caller's data"*.

Account mechanics, and why each choice was made:

| Concern | Implementation | Reasoning |
| --- | --- | --- |
| Password rule | `validatePasswordStrength()` in `core/security.ts`, imported by the browser via `src/core/auth.ts` | One function, both sides. A second copy in the client is how "it passed here, it failed there" bugs are born — `tests/unit/auth.test.ts` compares both entry points over a battery of passwords. |
| Password storage | Never stored by this app. Supabase Auth hashes it server-side. | The browser holds a password in React state for one submit, clears it in a `finally`, and never logs it. |
| Minimums | ≥10 characters, ≤72 bytes, not a repeated character, not a keyboard/number run, not on the common-password list | See the policy note below. |
| Sign-out | `signOut()` (this device) and `signOutEverywhere()` → `signOut({ scope: 'global' })` | Revoking only the local token leaves a stolen refresh token alive. The button people need after losing a device must exist. |
| Session facts shown | `describeSession()` — email, provider, expiry | The UI never renders the access or refresh token; a test asserts the serialised facts contain neither. |
| Attempt throttling | `POST /auth-guard` (pre-flight), see §4 | Supabase Auth rate-limits too, but that is out of our control and invisible to the app; this makes the app's own ceiling explicit and testable. |

### Password policy: length over composition

The rule is **length plus a blocklist, not character classes**. `validatePasswordStrength` reports how many
character classes are present, and the meter uses it, but it does not reject a password for using only one.
This was a deliberate change during the accounts work, recorded in `tests/unit/security.test.ts`
(*"accepts a long single-class passphrase — length beats composition"*).

The reasoning, since the opposite rule is so common:

- Requiring "one capital and one symbol" rejects `correct horse battery staple` and accepts `Password1!`.
  It selects for the passwords that password-cracking tooling tries first.
- Current guidance (NIST SP 800-63B §5.1.1.2) is to require length, check against a blocklist of known-bad
  passwords, and drop composition rules; the blocklist check here covers `password123`, `letmein123`,
  `qwertyuiop`, `graphmentor` and similar.
- The byte cap is what protects the server's hashing cost, and it is unchanged: 72 bytes, rejected — **never
  silently truncated**, which would produce a password shorter than the one the user typed.

**Does not cover:** a compromised Supabase project, a leaked `service_role` key (which bypasses RLS by
design), or an attacker who controls the user's email inbox. There is no 2FA: adding it means TOTP enrolment,
recovery codes and a threat model of its own, and a half-built second factor is worse than none.

## 3. Injection

| Vector | Defence |
| --- | --- |
| SQL / PostgREST injection | All database access goes through typed helpers (`supabaseStore.ts`); values are bound, never interpolated. Sort columns and filters come from fixed allow-lists. |
| Cypher injection | Every value is passed as a **query parameter** to the Neo4j HTTPS Query API. Identifiers (labels, relationship types, limits, depths) are allow-listed and range-clamped, because Cypher cannot parameterise those. Made structural rather than aspirational by `tests/unit/hardening-invariants.test.ts`: no shipped query may contain template interpolation or string concatenation (because there is nothing to concatenate — the queries are literals), and every cardinality bound must arrive as `$limit`, with `LIMIT 1` the only permitted literal. |
| NoSQL injection | Object bodies are parsed by zod **strict** schemas: unknown keys are rejected outright, so operators like `$ne` cannot be smuggled in. A test asserts that `?admin=1` is a 422. |
| Server-side template injection (SSTI) | `detectTemplateInjection()` in `security.ts` screens untrusted text for `{{ }}`, `${ }`, `{% %}`, `#{ }`, and Python format-string attribute access (`{user.__class__}`). This caught a real bug: the original pattern had a doubled brace and let `__class__` payloads through. |
| Prompt injection into the AI | Graph content and user text are wrapped in `CONTEXT-BEGIN`/`CONTEXT-END` markers and screened (`screenForPromptInjection`); the answer is assembled from graph facts first and the model is instructed that context is data, not instructions. A handler test sends *"ignore your instructions and …"* and asserts it is neutralised, not obeyed. |

## 4. Denial of service

- **Long-password DoS** — two different ceilings, doing two different jobs, both measured in **UTF-8 bytes**
  rather than characters because a 1 MB password can be a few hundred thousand characters:
  *The policy limit* (`DEFAULT_PASSWORD_LIMITS.maxBytes`, 72) is what a password may be *stored* as; a longer
  password is refused rather than truncated, so hashing cannot be made expensive by input length and two
  different passwords can never collapse to the same one. *The input ceiling*
  (`PASSWORD_INPUT_CEILING_BYTES`, 1024) is what the app will *look at*, and it is enforced three times over,
  each layer independent of the others:

  | Layer | Where | Behaviour on an oversized value |
  | --- | --- | --- |
  | Field | `AuthPage.tsx` → `maxLength={512}` on all four password fields | The browser refuses to accept more typing or paste |
  | Client | `src/core/auth.ts` → `refuseOversizedPassword()` in sign-in, sign-up and `updatePassword` | Refused *before any network call*, so a scripted client cannot force a hash |
  | Server | `handlers/authGuard.ts` step 0, fed by `passwordBytes` in `authGuardBodySchema` (integer 0–8192) | An attempt over the ceiling still spends an auth bucket, then returns `400 validation_failed` with the limit named — and never echoes the submitted count back |

  The ceiling is checked before the address is hashed or any bucket is written, so a flood of 1 MB passwords
  cannot be turned into a hashing or database load. Tests count bytes, not characters: 300 × `🔐` is 1200
  bytes and is caught, where a `.length` check would have seen 600. A 1 MB password is refused in under 50 ms
  (`tests/unit/security.test.ts`), and a 120-byte passphrase is still allowed by the guard
  (`tests/integration/handlers.test.ts`), which is the point of a ceiling rather than a low cap.
- **ReDoS** — `security.ts` runs a redundant-path guard over user-supplied patterns and rejects
  catastrophic backtracking shapes; pathological inputs are pinned by tests. The shipped patterns are held
  to the same standard as the ones that screen input: `listSecurityPatterns()` exposes every pattern the
  server actually runs, and a test times all of them against a 12-input hostile corpus (nested braces,
  quadratic-space runs, a 1000-character near-miss, a JWT-shaped string). Every pattern must finish under
  250 ms and the whole pipeline under 500 ms, so a future "clever" regex that backtracks catastrophically
  fails the suite instead of hanging a request.
- **Payload size** — JSON bodies are capped (`MAX_JSON_BODY_BYTES`, 4 KiB–128 KiB, default 32 KiB) and
  return `413 payload_too_large`. Text fields have per-field caps; oversized arrays are rejected.
- **Query cost** — graph reads are bounded by `SLICE_LIMITS` (depth 1–6, max 10–400 skills, 8 projects,
  12 resources) and `NEO4J_MAX_ROWS` (default 400). Cypher depth and row limits are clamped server-side,
  never taken from the client. Independent query timeout (default 8 s) with at most 3 jittered retries.
- **Rate limiting** — fixed windows counted in Postgres (so they survive isolates and cold starts):
  `RATE_LIMIT_CHAT_PER_MINUTE` (6, plus a hard 30/hour ceiling), analysis 20, writes 30, default reads 90.
  Buckets are keyed by user id when signed in, otherwise by IP. **Sign-in attempts** have their own ceilings
  (`authAttemptPerMinute` 10, `authAttemptPerHour` 40, `authAttemptPerIpPerMinute` 30, all env-tunable),
  enforced by `POST /auth-guard` *before* the browser talks to Supabase Auth.
- **What the limiter does when the store breaks** — the choice differs per control on purpose, and each
  direction is argued rather than assumed:

  | Store | Broken → | Why |
  | --- | --- | --- |
  | Rate-limit counters | **fail open** | An outage must not lock every learner out of a free study tool. Per-request cost caps (depth, rows, timeouts, body size) still bound the damage. |
  | Sign-in guard | **fail open** | Same reasoning: Supabase Auth's own rate limiting remains the backstop, and a sign-in outage is the worse failure. `tests/integration/authGuard.test.ts` pins the behaviour *and* asserts the response does not leak the reason. |
  | Replay nonces | **fail closed** | Here an outage means a replayed write could be accepted, which is a correctness and integrity failure rather than an availability one. |
- **Expensive endpoints** — `mentor-chat`, `generate-learning-roadmap` and `save-roadmap` can additionally
  require an HMAC signature (`REQUIRE_REQUEST_SIGNING=true`).

## 5. Replay and request integrity

When signing is enabled, the client signs `method \n path \n timestampMs \n body` with HMAC-SHA256; the
server verifies the signature, checks the timestamp against `REQUEST_MAX_SKEW_MS` (default 120 s), and
**claims the nonce exactly once** through an atomic insert. Verification failure reasons are explicit and
distinguishable in tests: `stale`, `future`, `mismatch`, `malformed`. A replayed request fails on the nonce,
not on the signature.

**Does not cover:** transport security (TLS is Supabase's and Neo4j's responsibility), or an attacker who
has stolen the signing secret.

## 6. Client-side storage and clipboard

- localStorage holds only: onboarding answers, self-reported skill states, roadmap task statuses, logged
  hours, bookmarks, display preferences, and (in demo mode) unsent feedback drafts. **No** tokens, no
  passwords, no chat transcripts, no credentials. `loadSkillRatings` and `loadProgress` drop malformed or
  oversized entries on read rather than trusting whatever is in storage.
- Every value read back from storage is treated as hostile input: wrong types are dropped, statuses outside
  the vocabulary are ignored, and out-of-range numbers discard the entry.
- The clipboard: the app **only ever writes** a share/copy action that the user explicitly triggers, and
  never reads the clipboard on load. There is no `paste` handler anywhere, so a clipboard-injection attack
  has no entry point. The only copy-to-clipboard paths are explicit user actions on text the user can see.
- What a *paste* can still carry is handled where the text lands. `safeText` strips invisible and
  bidirectional formatting characters (U+202A–202E overrides, U+2066–2069 isolates, U+200B/U+200C/U+200D
  zero-widths, U+061C, U+FEFF) from every free-text field before it is stored, so text pasted from a browser,
  a PDF or a chat client cannot be stored as something that *renders* as different text than it is — the
  classic "trojan source" trick of making `career:controls-engineer` display as `career:power-engineer`.
  Control characters are treated differently on purpose: they are *rejected*, not stripped, because a caller
  sending them has made a mistake worth reporting. Both behaviours are pinned in
  `tests/unit/validate.test.ts`, including the asymmetry test that keeps them from drifting together.
- The user can export everything and erase it in one action (Settings) — and `eraseAll()` reports which
  keys it removed rather than claiming success blindly.

## 7. File uploads

There is **no upload surface at all**: no file input, no multipart endpoint, no storage bucket, no
`upload()` call anywhere in the repository. Nothing to protect against because nothing exists. That is the
strongest form of upload security, but it is only true until somebody adds a `<input type="file">`, so
`tests/unit/hardening-invariants.test.ts` asserts the absence rather than trusting a comment: no component
may render a file input, nothing client-side may build a `FormData` or a multipart request, no Edge Function
may read or write files or open a storage bucket — and the landing page may not keep claiming the absence
after it stops being true. If uploads are ever added, this is the test that fails first, and they need their
own design: content-type allow-list, size cap, magic-byte sniffing, a separate origin or bucket, and never a
filename taken from the client.

## 8. Error handling and information leakage

`toErrorResponse` maps internal failures to a fixed vocabulary with safe public messages:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `validation_failed` | 422 | Input rejected; field-level details only |
| `bad_request` | 400 | Malformed request |
| `unauthorized` | 401 | No or invalid session |
| `forbidden` | 403 | Authenticated but not allowed |
| `not_found` | 404 | Missing, or not yours (the two are indistinguishable on purpose) |
| `conflict` | 409 | Duplicate / state clash |
| `payload_too_large` | 413 | Body over the cap |
| `rate_limited` | 429 | Includes `retryAfterSeconds` |
| `dependency_unavailable` | 502 | Graph or database unreachable |
| `not_configured` | 503 | Feature not set up on this deployment |
| `internal` | 500 | Everything else |

Never returned: SQL text, Cypher, stack traces, file paths, hostnames, upstream error strings, or whether a
record belongs to another user. That last clause is enforced at the data layer too: a foreign row and a
nonexistent row are not merely *described* the same way, they are indistinguishable to the query that looks
for them (Row Level Security makes another account's row simply not visible), and
`tests/integration/store-authorization.test.ts` asserts both paths produce the identical error message. The
same file pins the related decision in `roadmaps.save`: a client-supplied row id is looked up under
`id = ? AND user_id = ?` **before** it can be used as a write target, so a stranger's id produces an ordinary
create rather than a distinguishable failure. `tests/integration/handlers.test.ts` asserts that a deliberately thrown
database error containing `duplicate key value violates unique constraint "saved_roadmaps_pkey"` reaches the
client as a generic `502 dependency_unavailable` with no trace of that string.

## 9. Headers, transport and CORS

- CSP, shipped three times because three delivery paths read different files: the `<meta>` tag in
  `index.html` (used by the Capacitor/Android WebView, and by any host that ignores header files),
  `public/_headers` (copied to `dist/` for static hosts) and `netlify.toml`. All three declare
  `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-src 'none'` and (where a header file can express it) `frame-ancestors 'none'`. The production build
  contains **zero** inline `<script>` blocks, which is why the service worker is registered from a module
  import rather than an injected snippet.
- Three copies of a policy is how a security header rots, so they are not kept in step by discipline:
  `tests/unit/hardening-invariants.test.ts` parses all three and requires every shared directive to carry an
  identical value in each, `script-src` to be exactly `'self'` everywhere, and `unsafe-eval` to appear
  nowhere. It also checks the *built* output when `dist/` exists — every host `dist/_headers` allows must
  appear in the built meta tag's `connect-src`, and the build-time placeholder must be gone — because a host
  added to the static headers but not to the build environment is a production-only failure. Writing that
  test found a real drift: the two header copies were missing `frame-src 'none'`, which has since been added
  rather than the assertion being relaxed. The same idea is applied to everything *else* those files carry:
  a second test compares `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Strict-Transport-Security`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` across both
  files, and refuses permissive leftovers (`unsafe-url` referrers, an HSTS without a max-age, a feature that
  stopped being denied). That is how the second real drift surfaced — `netlify.toml` was missing both
  cross-origin isolation headers that `public/_headers` had, so one host was measurably weaker than the
  other until the test was written.
- **Styles are the interesting case, and the policy now differs by mode.** A development server that cannot
  show its own styles is not usable, and Tailwind's HMR runtime injects `<style>` elements while editing — so
  the dev policy keeps `style-src 'self' 'unsafe-inline'`. The *built* policy does not:

  | | `style-src` | `style-src-elem` | `style-src-attr` |
  | --- | --- | --- | --- |
  | `npm run dev` | `'self' 'unsafe-inline'` | — | — |
  | `npm run build` (and the Capacitor app, which ships `dist/`) | `'self'` | `'self'` | `'unsafe-inline'` |

  The build refuses injected `<style>` elements outright. Nothing in the app needs them: its only stylesheet is
  a `<link>` to its own bundled CSS, its dynamic styles are applied through the CSSOM (which CSP does not
  govern), and the shipped HTML contains no literal `style` attribute anywhere — the no-JS fallback block was
  moved into the stylesheet for exactly that reason. `style-src-attr` stays permissive as the fallback for a
  browser that only understands CSP level 2, which cannot express element and attribute rules separately; the
  `style-src 'self'` above it is that level's view of the same intent. The mode is substituted at build time
  through a `__CSP_STYLE_SRC__` placeholder in `index.html`, and a test asserts the placeholder is still a
  placeholder — otherwise a dev-only relaxation could be shipped by accident, and nothing would look wrong.
- **The policy is checked in a browser, not just in a file.** `npm run verify:browser` §10 loads the built app
  in Chromium and checks that an injected `<style>` element has *no effect* and raises a violation naming
  `style-src-elem`, that a `style` attribute still applies, that the app itself trips nothing on load, and
  that the graph view blocks exactly one thing. That last one is worth spelling out, because two real
  findings came out of writing it:

  | What the browser reported | What it meant | What was done |
  | --- | --- | --- |
  | `script-src eval`, attributed to the entry bundle, ~110 ms into every page load | **zod v4** probes for eval permission (`new Function("")` inside a try/catch) to decide whether it may compile validators with its JIT fast path. The probe was refused, caught, and zod silently used its interpreter — so nothing was broken, but a strict CSP reports the attempt, and this one was reported on every page. | `src/core/zod-config.ts` sets zod's documented `jitless` flag, imported first in `main.tsx` because the probe fires during module evaluation. zod's own source names this scenario (*"strict CSPs report the caught `new Function` as a `securitypolicyviolation` even though the throw is swallowed"*). Violations on load: 0. |
  | `style-src-elem inline` on the graph view | **Cytoscape** injects a one-rule `<style>` element to give its container `position: relative`, and warns to the console if the computed position is static. | The refusal is kept — the app now declares that position in its own stylesheet (`.gm-graph-surface`), and §10 asserts the computed value is `relative` and the canvas is still laid out at 571×420 px. So the block is proven to cost nothing. A `test` pins that this is the *only* blocked resource on that page. |

  The alternative for the second one was to add the blocked stylesheet's hash to the policy so Cytoscape's
  injection would be allowed. That was rejected: it would re-enable exactly the capability the policy exists
  to deny, in exchange for silence. The console error Chromium logs for the refused injection is matched by
  its exact text in the browser suite's console-hygiene check, so any *other* error still fails the run.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS, and a
  Permissions-Policy that denies camera, microphone, geolocation, USB and payment.
- CORS: an explicit allow-list, echoed with `vary: origin`. A bare `*` is never returned, so a hostile page
  cannot read answers with a user's token.
- Private responses are `no-store`; public curriculum reads are cached 60–300 s and are safe to cache
  because they contain no user data.
- The Android build runs the same web assets on `https://localhost` with mixed content disabled, no extra
  navigation allow-list, and no runtime permissions requested (no location, camera, contacts or storage).

## 10. Secrets management

| Secret | Where it lives | Never |
| --- | --- | --- |
| Neo4j URL / user / password | `supabase/.env` → Edge Function secrets | never in the frontend `.env`, never in `neo4j/*.cypher`, never in logs |
| AI provider key | Same | same |
| `service_role` key | Same | never in `VITE_*` (which is compiled into the bundle) |
| Signing secret | Same | same |

`scripts/scan-secrets.mjs` scans every tracked file for credential-shaped strings (long random tokens, key
prefixes, connection URIs with passwords, private-key headers) and fails the build. It now makes **two**
passes, because source scanning cannot see what a bundler inlines:

| Pass | Scope | Why it exists |
| --- | --- | --- |
| Source | every `.ts`, `.tsx`, `.mjs`, `.json`, `.sql`, `.md`, `.yml`… in the repository | The usual case: a key pasted into a file by mistake |
| Bundle | the built output under `dist/` — every `.js`, `.css`, `.html`, `.json`, `.svg` and the `_headers` file | `VITE_*` values are compiled into the JavaScript a visitor downloads. A source scan of `src/` cannot see that, and an env key that reached the bundle is public. If `dist/` exists but no file in it can be read, the run fails rather than reporting a clean bundle it never looked at. |

Two properties keep the scanner trustworthy instead of turning it into noise:

- **A canary.** `scripts/secret-scan-canary.mjs` holds planted secrets (a plain password assignment, an
  opaque access token, a provider key, a JWT, a PEM header, a connection URI with an inline password) and
  genuine placeholders (`REPLACE_WITH_…`, `<your-api-key>`, `change-me`, `process.env.…`, an env-var
  interpolation, and the `access_token:"access_token"` shape that minified bundles are full of). Every run
  reclassifies all 14 and **fails if any is wrong**, so a scanner that has quietly stopped matching can never
  print a clean result. A scanner that silently sees nothing is worse than no scanner, because the green
  output still reads as "no credentials here".
- **Visible exemptions.** A deliberate fake may carry a `// secret-scan:allow` comment, and the number of
  exempted lines is printed on every run with the `grep` command to review them — currently 3, all in test
  files, all fixtures whose entire purpose is a fake secret. Placeholders are recognised by *shape* through
  the allow-list, so the plaintext-comparison problem of maintaining a list of specific strings does not
  arise. The marker must be a comment: it cannot be smuggled in as a string value, and the scanner never
  exempts itself (its own documentation names the marker).

Tightening that allow-list found a real hole rather than a nit: the previous version allow-listed any match
containing the bare words "password", "secret" or "token", on the theory that prose about secrets should not
trip the scanner. Because every match of the assigned-secret rule *contains its own key name*, that pattern
waved through a plain `password = …` assignment, a 32-character `secret: …` value and an opaque
`access_token: …` — precisely the leaks the rule exists to find. It has been replaced with placeholder-shape
patterns, and the three test fixtures that legitimately hold fake secrets were the only things that needed an
explicit marker. `tests/unit/hardening-invariants.test.ts` closes the related gap from the other side:
`readConfig` must ignore non-`VITE_` keys even when the whole environment is passed to it, so a
misconfiguration cannot put `SUPABASE_SERVICE_ROLE_KEY` into the client config, and the built bundle is
asserted to contain no JWT, private key header or credentialed connection string.

The dataset is also screened by `npm run validate:seed`, which refuses to emit Cypher containing
credential-shaped strings. Error messages and logs never include prompt text, user content or secrets
(`LOG_LEVEL` controls verbosity only; content is redacted regardless).

## 11. Privacy of stored data

- RLS scopes every private row to `auth.uid()`. The `roadmap_tasks` table carries a composite foreign key to
  `saved_roadmaps (id, user_id)`, so a task cannot be attached to another user's roadmap even by a buggy query.
- Feedback rows record whether the sender was signed in, plus the optional contact address they chose to
  give; nothing else is attached.
- Chat transcripts are not persisted by default. The mentor sends the graph context it needs for the current
  answer and does not write a transcript to the database.
- Data rights are implemented, not promised: export (JSON, both device and account copies clearly separated)
  and deletion, both reachable from Settings without contacting anyone. Account export and deletion go
  through `api().manageAccount(...)`, the same client every other request uses, so they inherit the session
  handling, error vocabulary and rate limits instead of hand-rolling a fetch.
- Deleting account data deletes the rows, not the login: removing an auth user needs the `service_role` key,
  which never goes near a browser. The UI says exactly that rather than implying the account is gone.
- On an unconfigured build there is no account to export or delete, and the API says so (`not_configured`)
  instead of reporting a deletion that never happened.

## 12. Sign-in threats specific to this app

Three that are easy to get subtly wrong, so they are written down with their tests:

**Account enumeration.** The sign-in screen answers identically whether an address has an account here:
registration failure, reset request and the guard's response are all deliberately vague
(*"That address cannot be registered. Try signing in instead…"*), and `describeAuthError` returns the *same*
string for `Invalid login credentials` and `User not found` — asserted by
`tests/unit/auth.test.ts` → *"does not leak which side of the check failed"*. The provider's own wording is
never passed through; a test feeds it a fake message containing `supabase-js`, a status code and a stack
frame and asserts none survive.

**The guard must not become an oracle.** `/auth-guard` receives a client-computed SHA-256 prefix of the
address rather than the address, so it can count attempts without being able to read, log or leak them. It
returns `allowed`/`attemptsLeft` and nothing else; the response never echoes the fingerprint it was given
(`tests/integration/authGuard.test.ts` → *"never returns the hash it was given back to the caller"*). A raw
email in the body is a 422, because the schema is strict — there is no field for it to land in.

**The reset flow.** Reset and magic links are single-use and short-lived. A stale or reused link lands on a
screen that says so and offers a fresh request — it does not show a password field
(`tests/integration/authPages.test.tsx` asserts there are zero password inputs on that screen until a link
session exists).

## 13. Threat checklist → control → test

The named threats, each mapped to where it is implemented and what would fail if it broke.

| # | Threat | Control | Code | Test |
| --- | --- | --- | --- | --- |
| 1 | Server-side template injection | Untrusted text is screened for `{{ }}`, `${ }`, `{% %}`, `#{ }` and Python format-string attribute access before it can reach any template | `core/security.ts` → `detectTemplateInjection`, `stripTemplateMarkers` | `tests/unit/security.test.ts` (marker detection, including the `__class__` case that the original doubled-brace pattern missed) |
| 2 | ReDoS | User-supplied patterns are screened for redundant-path/backtracking shapes; matching is bounded; literal search input is escaped; **and every shipped pattern is timed** against a hostile corpus | `core/security.ts` → `isUnsafePattern`, `safePatternTest`, `escapeRegExp`, `buildSafeSearchPattern`, `listSecurityPatterns` | `tests/unit/security.test.ts` (46 — pathological inputs pinned with time bounds; each shipped pattern <250 ms and the pipeline <500 ms over 12 adversarial inputs) |
| 3 | Long-password DoS | A 72-byte **policy** limit (over-long input refused, never truncated) plus a 1024-byte **input ceiling** enforced in the form, in the client before any network call, and again in the handler; bodies capped at 32 KiB | `core/security.ts` → `PASSWORD_INPUT_CEILING_BYTES`, `passwordExceedsInputCeiling`, `DEFAULT_PASSWORD_LIMITS`; `src/core/auth.ts` → `refuseOversizedPassword`; `handlers/authGuard.ts` step 0; `src/features/auth/AuthPage.tsx` | `tests/unit/security.test.ts` (46 — byte-counted, 300 × `🔐` = 1200 bytes caught, 1 MB refused in <50 ms), `tests/unit/auth.test.ts` (17), `tests/integration/handlers.test.ts` (over-ceiling 400 names the limit and never echoes the count; a 120-byte passphrase still passes) |
| 4 | Secret key leaks | `service_role`, Neo4j and AI keys live only in Edge Function secrets; the frontend bundle carries only the anon key, which is safe only because every table has RLS; a scanner fails the build on credential-shaped strings **in the source and in the built bundle** | `scripts/scan-secrets.mjs` (two passes), `scripts/secret-scan-canary.mjs`, `src/core/env.ts`, `supabase/.env.example` | `npm run lint:secrets` (the source tree — 363 files at this build — **and** the built bundle, 29 files, with a 14-fixture canary), `tests/unit/hardening-invariants.test.ts` (`readConfig` ignores non-`VITE_` keys; the bundle holds no JWT, key header or credentialed URI), `npm run validate:seed` |
| 5 | NoSQL / SQL injection | Parametrised Cypher only (no string interpolation of values); allow-listed labels, relationship types and sort keys; strict zod bodies so operators like `$ne` cannot be smuggled in; Supabase/PostgREST filters take bound values, never concatenated SQL | `core/graphQuery.ts`, `core/neo4jReader.ts`, `core/validate.ts`, `platform/supabaseStore.ts` | `tests/unit/hardening-invariants.test.ts` (no shipped query contains `${…}` or string concatenation; every bound is `$limit` or the single-entity `LIMIT 1`), `tests/unit/validate.test.ts` (25 — unknown-key 422, `?admin=1` rejected), `npm run verify:injection` (10/10 — the rendered product, not only the validator) |
| 6 | Clipboard attack | The app **never reads** the clipboard — no `paste` handler exists anywhere. Clipboard writes happen only on an explicit user action, for text the user can see. Anything a paste *does* carry is neutralised on the way in: invisible and bidirectional formatting characters are stripped from every free-text field, so stored text cannot render as something other than what it is | `src/features/**` (copy actions); `core/validate.ts` → `safeText` + `core/security.ts` → `stripBidiAndFormat`, `hasInvisibleOrBidi`; `core/security.ts` → `sanitizeUntrustedText` at the storage boundary | `tests/unit/validate.test.ts` (25 — U+202E, U+200B, U+FEFF and the U+2066–2069 family stripped; control characters still rejected, keeping the two treatments from drifting together) |
| 7 | Replay attack | HMAC-SHA256 over `method \n path \n timestamp \n body`, a ±120 s skew window, and a nonce claimed exactly once through an atomic insert. Enabled per-deployment via `REQUIRE_REQUEST_SIGNING` | `core/security.ts` → `verifySignedRequest`; `handlers/shared.ts` → `enforceSignedRequest` | `tests/unit/security.test.ts` (`stale`, `future`, `mismatch`, `malformed`), `tests/unit/rateLimit.test.ts` (nonce store fails closed) |
| 8 | Rate limiting | Fixed windows in Postgres (survive isolates and cold starts) keyed by user id, else IP: chat 6/min + 30/h, analysis 20/min, writes 30/min, reads 90/min — plus the sign-in ceilings in §4 | `core/rateLimit.ts`, `platform/supabaseStore.ts`, `handlers/authGuard.ts`, migrations `001`/`002` | `tests/unit/rateLimit.test.ts` (10), `tests/integration/authGuard.test.ts` (13, including the host ceiling) |
| 9 | Input validation | Every body, query and param parsed by a **strict** zod schema; unknown keys rejected; enums from fixed vocabularies; length caps per field; untrusted display text sanitised (bidi overrides and zero-width characters stripped, control characters rejected) | `core/validate.ts`, `core/security.ts` → `sanitizeUntrustedText`, `stripBidiAndFormat` | `tests/unit/validate.test.ts` (25), `tests/unit/security.test.ts` (46), `tests/unit/cors.test.ts` (9 — a bare `*` is answered with a literal `*` and never with credentials; an apex domain is not matched by a wildcard-subdomain pattern), `npm run verify:injection` (10/10) |
| 10 | Authentication ≠ authorization | Every write resolves the caller itself (`requireUser`) and then filters by that user id; ownership is enforced a second time in Postgres by RLS (`auth.uid() = user_id`, both `USING` and `WITH CHECK`); `roadmap_tasks` carries a composite FK to `saved_roadmaps (id, user_id)` so a task cannot be attached to someone else's plan even by a buggy query; **a client-supplied row id is proven to belong to the caller before it can be used as a write target**; the auth verifier asks the Auth server for the user and never trusts a token's own claims | `handlers/shared.ts`, `handlers/user.ts`, `platform/supabaseStore.ts` (ownership lookup in `roadmaps.save`, `createAuthVerifier`), `supabase/migrations/001_graphmentor_core.sql` | `tests/integration/store-authorization.test.ts` (17 — every write carries the caller's id; a foreign id becomes a create; a foreign row and a missing row are byte-identical in the response; a forged or unreachable-auth token gets nowhere), `tests/integration/handlers.test.ts` (43), `npm run verify:rls` (42/42) |
| 11 | Secrets management | Distinct secrets per concern; no default fallbacks; the health check reports *whether* things are configured without echoing values; logs redact secret-shaped keys and values | `core/security.ts` → `redactSecrets`, `redactSecretsInString`; `core/runtimeConfig.ts` | `tests/unit/security.test.ts` (redaction), `handlers/health.ts` integration assertions |
| 12 | File upload security | There is **no upload surface** — no file input, no multipart endpoint, no `upload()` call, no storage bucket. Nothing to exploit because nothing exists | absence is asserted, not assumed (see §7) | `tests/unit/hardening-invariants.test.ts` — no file input in any component, no `FormData`/multipart anywhere, no file or bucket access in any Edge Function, and the landing page's claim is checked against the code it describes |
| 13 | Error handling and information leakage | One mapping from internal failure to a fixed public vocabulary (see §8); `not_found` is deliberately indistinguishable from "not yours" — in the message *and* in the query that produces it; provider error strings, SQL, Cypher, stack traces and hostnames never reach a client | `core/http.ts` → `toErrorResponse`, `core/errors.ts`, `src/core/auth.ts` → `describeAuthError`, `platform/supabaseStore.ts` (identical failure for a foreign or missing row) | `tests/integration/handlers.test.ts` (43 — a real Postgres constraint string arrives as a generic 502), `tests/integration/store-authorization.test.ts` (17), `tests/unit/auth.test.ts` (17 — provider wording is rewritten) |
| 14 | A storage backend with no database-enforced policy | On Appwrite a server API key bypasses collection permissions, so the ownership policy is enforced in the adapter **before a request is built**: an unscoped select/update/delete on a user-owned collection, an ownerless write, and a `PATCH` onto another account's document are all refused. Every collection is created with no role permissions at all, so the browser-facing surface is still only our API | `platform/appwrite.ts` → `assertScoped`, `assertOwned`; `platform/appwriteSchema.ts` (a unique index for every upsert target); `platform/deno.ts` → `selectBackend` (a half-configured Appwrite is not a Supabase fallback) | `tests/unit/appwrite-adapter.test.ts` (41), `tests/integration/appwrite-backend.test.ts` (8 — a 21-request replay on both backends, plus storage-level isolation and a deletion that spares the other account), `npm run audit:self` → `storage.*` (2 checks: the schema covers the store, and the scope guards fire with zero requests sent) |

### What this hardening pass changed, and why

Every class above was audited against the code that actually ships. Most were already defended; the fixes
below are the ones the audit found, each with the reason it was worth changing. Nothing here is a
"considered and decided against" — those are in §14.

| Fix | Why it was a real gap |
| --- | --- |
| Password **input** ceiling (1024 bytes) enforced in the form, in the client before any network call, and in `authGuard` step 0 — deliberately separate from the 72-byte *policy* limit | The policy limit lived in password *strength checking*, which runs after a password exists. Nothing bounded the work done to receive one, so a 1 MB password could be submitted as many times as the rate limiter allowed. Byte counting was already in the codebase; it was simply not applied to the input path. |
| `safeText` now strips bidi and zero-width characters (control characters are still rejected) | §6 explains the threat the clipboard creates. The sanitizer ran at the display boundary but not at the validation boundary, so a value could be *stored* with an embedded override and only cleaned later — if every future reader remembered to call it. |
| `listSecurityPatterns()` + a timing suite over every shipped pattern | The ReDoS guard screened *user-supplied* patterns. The patterns the server ships were trusted on inspection, which is exactly the kind of trust that decays when someone adds a "better" one. Now they are timed against a hostile corpus on every run. |
| The scanner's prose allow-list replaced with placeholder-shape patterns, and an explicit `secret-scan:allow` marker (counted in the output) for deliberate fakes | It was silencing the highest-value findings: any assignment whose value sat next to the word "password", "secret" or "token" — including its own key name. A leak could sit in the repository and the scan would still report clean. |
| The scanner now scans `dist/`, and reclassifies a 14-fixture canary on every run | Source scanning cannot see what Vite inlines, and a scanner that has stopped matching reports the same green as one that found nothing. Both are now impossible without the run failing. |
| `frame-src 'none'` added to `public/_headers` and `netlify.toml`, plus a test that compares all three CSP copies directive by directive | The meta tag denied framing of subframes; the two header files relied on `default-src` to do it. None of the three were checked against each other, so a directive tightened in one file and forgotten in the others would have shipped. |
| Invariants for things that were true by inspection: no HTML injection sink, no upload surface, no interpolated Cypher, no secret-shaped string in the bundle | These were all true. They were true *by inspection*, which means the next commit could make one false and nothing would notice — including the landing page, which tells the reader "there is no upload endpoint, no storage bucket and no file input anywhere in the app". That sentence is now checked against the code it describes. |
| `roadmaps.save` proves ownership of a client-supplied row id before using it as a write target | The id was the upsert's conflict target, so safety rested on how Postgres resolves `INSERT … ON CONFLICT DO UPDATE` against a row the caller cannot see under RLS — correct today, subtle, and dependent on the policy. It also made a stranger's id behave differently from one that does not exist. Ownership is now established by the query itself, and a transient failure to establish it fails the request instead of guessing. |
| Per-mode CSP: the dev policy keeps `'unsafe-inline'` for Tailwind's HMR, the built policy refuses injected `<style>` elements, substituted through a placeholder | The relaxation existed for a development-time reason and was shipping to production. Nothing in the built app needed it, which the browser suite now demonstrates rather than asserts. |
| `.gm-graph-surface` declares `position: relative` instead of inheriting it from a library's injected stylesheet | The element whose canvas is drawn into it was being positioned by CSS that a strict CSP blocks. That is a latent dependency on a side effect, and it would have failed silently — the library only *warns* — the moment the policy tightened. |
| zod configured `jitless` (`src/core/zod-config.ts`, imported first in `main.tsx`) | A dependency attempted dynamic code generation on every page load. The attempt was caught and harmless, but it produced a CSP report per visitor, and a security signal that fires for a non-event is a signal people learn to ignore. |
| `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` added to `netlify.toml`, plus a test comparing *every* security header across both header files | `public/_headers` had them, `netlify.toml` did not — found only because writing the CSP drift test prompted comparing the rest of the headers too. A deployment on one host was measurably weaker than the other. |
| `rel="noopener noreferrer"` on outbound links, now enforced by a test that parses every anchor | All four links already had it. The test exists because good luck is not a control: the links point at third-party course sites, and reverse tabnabbing needs only one new anchor written without it. |
| `npm run verify` — the whole chain in one command, naming any step it skips | The evidence existed as a set of commands run by hand. One command that reports *skipped* steps as skipped keeps a green summary honest, and makes the claims checkable by someone who does not already know the incantations. |
| `tests/integration/store-authorization.test.ts` and `tests/helpers/fakePostgrest.ts` | Authorisation was tested through handlers against an in-memory repository that *imitates* the ownership rule. Nothing asserted the queries the real store builds — that each write carries the caller's id, or that a supplied id is looked up under the caller's id first. The rule is now checked at the layer that talks to Postgres, without needing a live database. |

### Where these controls were exercised against real infrastructure

The table above is code-and-test evidence. Four runs drive the same code against real infrastructure, all
four are local, and each of the first three found something the jsdom tests could not (details and
boundaries in [verification.md](verification.md) §5):

| Run | Command | Result | What it adds to the table |
| --- | --- | --- | --- |
| RLS with the migrations unmodified | `npm run verify:rls` | 42/42 | Rows 8 and 10 stop being claims about SQL text: thirteen intruder attacks are refused by the policies themselves, and 64 concurrent limiter increments produce exactly 64 |
| The auth path over a real socket, limiter in Postgres | `npm run smoke:http` | 30/30 | Rows 1–4, 9, 13 at the HTTP edge: 429 with `retry-after`, byte-identical answers for two addresses, CORS and method handling, error bodies carrying no stack or SQL |
| Nine hostile payload classes plus the guest-mode claim, typed into the product's own controls in a real browser | `npm run verify:injection` | 10/10 | Rows 5, 6 and 9 stop being claims about validators: a `<script>`, an attribute break-out, a `javascript:` URL, an SVG `onload`, `{{ }}` syntax, Cypher/SQL-shaped text, a `{"$ne": …}` object, a bidi override and a 20 kB value were each typed into all 8 editable controls on 4 routes, submitted, and echoed back as literal text on the ones that commit — with no element created, no handler attached, no dialog raised, no screen blanked and no page error. `/login` is checked as a claim of its own: in a build with no Supabase project it renders zero password fields and says so |
| The WebGL and neumorphic UI, the command palette, and the Content-Security-Policy actually being enforced, in a real browser engine | `npm run verify:browser` | 112/112 | Not only a security row: it is the evidence that the scenes, the neumorphic material (including that no surface carries a backdrop blur), the 360 px layout and reduced motion are real rather than CSS that never ran — and, in its §10, that the browser *refuses* an injected `<style>` element, that a style attribute still applies, that the app loads without tripping its own policy, that the graph surface positions itself without the stylesheet the policy blocks, and — in §11 — that the delta view's three renderings of the same numbers agree with each other |

Because none of this is a deployment, **`service_role` has never been used against a hosted Supabase
project, no JWT has ever been verified by GoTrue, and no secret has ever been stored in a real project's
secret store.** The Appwrite adapter is in the same position: **no live Appwrite project has been run
against this code.** Its tests exercise a model of the document API (`tests/helpers/fakeAppwrite.ts`) built
from the published request and response shapes, which is enough to pin the adapter's behaviour and not
enough to prove the service's — [appwrite.md](appwrite.md) says so in the same words. Those remain unexercised, and [verification.md](verification.md) §6 says so.

## 14. What is not defended (deliberately or by scope)

- A malicious browser extension, a rooted device, or someone with access to an unlocked browser profile can
  read local storage. The app says this on the Settings screen and suggests erasing local data on shared computers.
- The AI provider (when enabled) is a third party: it receives the graph context and your question. The
  privacy page says so in plain language, and the default configuration sends nothing at all.
- There is no account-takeover protection beyond Supabase Auth's own flows (email link, password reset), no
  2FA, and no device list. "Sign out everywhere" is the blunt instrument that exists.
- Availability is bounded by free-tier quotas. The app degrades to demo mode and says so, but it does not
  promise uptime.
- `style-src-attr 'unsafe-inline'` remains in the built policy, as the CSP-level-2 fallback described in §9.
  Everything the app does would work without it (React applies styles through the CSSOM, which CSP does not
  govern), but a browser that cannot distinguish attributes from elements would block any literal `style`
  attribute under a bare `style-src 'self'` — and this app ships none, so removing it would buy nothing and
  risk exactly the kind of silent cosmetic breakage that hides in static markup. Injected `<style>` elements
  *are* refused in the build.
- One dependency injects a stylesheet the policy refuses, and the console error Chromium logs for it is
  expected: see the Cytoscape row in §9. It is blocked deliberately, and the block is verified harmless rather
  than argued harmless.
- The Appwrite path trades one guarantee for another: Postgres enforces ownership *in the database*, so a
  bug in a query cannot leak another account's rows. Appwrite does not have that backstop — the adapter
  refuses unscoped queries, which means the guarantee rests on that code being right (and on its tests and
  the `storage.*` self-audit checks). If you need the database-enforced property, run Supabase. Both are
  supported, and neither is presented as equivalent to the other.
- No penetration test or external security review has been performed on this code. The claims here are
  about what is implemented and unit-tested, not about being unconditionally secure. Nothing on any screen
  promises that this app cannot be broken — only what it does, and what it refuses to do.


