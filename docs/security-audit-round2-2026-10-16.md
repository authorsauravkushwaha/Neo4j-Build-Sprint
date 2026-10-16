# Repository security audit, second pass — 16 October 2026

## Executive conclusion

**Five further defects were found and remediated. No evidence of exploitation, and no
production deployment was attacked.** This pass exists because the first audit
(`docs/security-audit-2026-10-16.md`, findings A01–A11) remediated two classes of defect in
*one* of the two places each class appeared. The duplicates it left behind are the two
highest-severity findings below.

That is the useful lesson from this review, and it is a general one: **a control that exists in
two copies is a control that will be fixed in one.** Both GM-SEC-001 and GM-SEC-002 are the
same defect as an earlier A-finding, surviving in a second implementation nobody re-checked.
Both are now single-implementation, so the next fix cannot miss a copy.

As in the first audit: priorities are qualitative triage, not CVSS scores, and none of these
entries is evidence of prior exploitation.

## Scope and method

- Baseline: `446f26d310272c1549c555693d4e66d33b231e6c` on branch
  `arena/981a271f-neo4j-build-sprint`.
- Method: white-box source review of the Edge Function HTTP/auth/rate-limit path, the browser
  workflow probe, the request-signing contract on both sides, the rate-limit key derivation, and
  both GitHub Actions workflows — followed by **adversarial regression tests written before each
  fix**, so every finding below was demonstrated against unmodified code and only then closed.
- The attack suite is `tests/security/` (5 files, 57 assertions). Each file's header comment
  states the exploit, the concrete request or script that performs it, and what the fix changes.
- **Not performed:** no external system was contacted, no credential was tested for validity, no
  live Edge Function, Supabase project, Neo4j instance or Postgres cluster was queried. There was
  no deployment to query. `npm run verify:rls` and `npm run verify:db` still skip without a
  database and still say so.

## Remediated defects

| ID | Priority / category | Evidence before change | Remediation and evidence after change |
| --- | --- | --- | --- |
| GM-SEC-001 | **High**: rate-limit bypass / guessing protection | `core/http.ts` derived `clientIp` as `cf-connecting-ip` ?? `x-real-ip` ?? the **first** `x-forwarded-for` hop, unconditionally. All three are ordinary caller-controlled headers; the Supabase Edge / Deno Deploy path sets neither of the first two, and *appends* to the third. Demonstrated: **500 requests from one client produced 250 distinct rate-limit buckets.** | New `clientIpFromHeaders` / `readClientIpOptions`. Single-valued proxy headers are ignored unless `TRUST_PROXY_HEADERS=true`; `x-forwarded-for` is read from the right by `TRUSTED_PROXY_HOPS` (default 1), because the rightmost entries are the ones our platform appended. Returns `null` rather than inventing an address. The same 500-request loop now yields **1** bucket. `/health-check` reports both settings so an operator can confirm them. Mirrors the gate `server/server.ts` already had (`AUTH_TRUST_PROXY`), which A01 fixed and the Edge path did not have. |
| GM-SEC-002 | **High**: outbound-policy bypass + credential leak | `src/core/workflowServices.ts` held a **second** copy of the workflow HTTP probe, and it had drifted to `redirect: 'follow'` with `credentials` unset (defaults to `same-origin`). A05 hardened `core/workflow/services.ts` and left this copy. `hostAllowed()` validates the URL a workflow *names* and never sees the URL a redirect *lands on*, so any allow-listed host with an open redirect became a trampoline to a host the policy refuses — and the probe carried the learner's cookies there. | Deleted the duplicate; the browser now calls the shared `createFetchProbe` (`redirect: 'error'`, `credentials: 'omit'`). One implementation, and it is the one whose comment explains why both options are load-bearing. Exported as `probeFetch(fetchImpl?)` and pinned by four assertions on the actual `RequestInit`. Not a complete DNS-rebinding defence — the same limitation A05 records. |
| GM-SEC-003 | **High**: replay protection unusable and unsound | The browser signed `method\npath\ntimestamp\nbody` (four fields); the server verifies `method\npath\ntimestamp\nnonce\nbody` (five). Two compounding defects: **(a)** every signed request failed as `mismatch`, so setting `REQUIRE_REQUEST_SIGNING=true` took `mentor-chat`, `generate-learning-roadmap` and `save-roadmap` offline for all users rather than hardening them — and nothing in `src/` ever supplied a `sign` implementation, so this had never run end to end; **(b)** the omitted field was the nonce, the one that makes a request single-use, so a captured request could be replayed indefinitely inside the skew window by supplying fresh nonces. Fixing (a) by aligning the *server* to the client would have shipped (b) silently. | New exported `signClientRequest` in `src/core/api.ts` signs via the shared `canonicalRequestString`, so field order and membership are defined once. The `sign` option now receives the complete parts **including the client-generated nonce** and returns only the signature — which makes omitting the nonce structurally impossible rather than merely unlikely. Tests assert client/server agreement end to end and that a nonce swap on a captured signature is rejected as `mismatch`. |
| GM-SEC-004 | **Medium**: pseudonymisation / personal data in a "no personal data" table | `bucketKey` was `sha256("graphmentor-rate:" + identifier)` — an unkeyed digest under a string literal published in this repository. Documented as "non-reversible", and migration 002 documents the counter table as containing "no personal data". Neither held: `auth.host` keys are IPv4 addresses (2^32 — a full offline sweep is minutes), and `auth.addr` keys are unkeyed digests of email addresses (ordinary wordlist attack). A reader of `public.gm_rate_limit` could recover which addresses attempted sign-in, and when, from the window timestamps. Demonstrated: an offline sweep of a /24 **recovered the stored key**. | `bucketKey(scope, identifier, pepper?)` is an HMAC under `RATE_LIMIT_PEPPER`, a server-side secret that never leaves the Edge Function environment. Threaded through `RuntimeConfig` and all four call sites. The unpeppered path is kept deliberately — counters must not stop limiting mid-rollout — but it now reports itself via `BUCKET_KEY_UNPEPPERED`, surfaced as `rateLimitKeysPeppered` on `/health-check`, instead of implying a property it does not have. Rotating the pepper resets in-flight budgets, so `.env.example` says to set it once before launch. |
| GM-SEC-005 | **Low** (not reachable by an outside contributor): CI expression injection | `deploy.yml` interpolated `${{ steps.target.outputs.base }}` and `${{ …url }}` directly into a `run:` block. A `${{ }}` in `run:` is substituted into the script text **before the shell parses it**, so the value becomes shell syntax rather than data. These values derive from the repository name and a step output, and the job is gated to `main` / `workflow_dispatch`, so no fork could reach it — but `vars.VITE_BASE_PATH` feeds that output, and the pattern gets copied into the next step where the value *will* be attacker-controlled. | Both values now arrive through `env:` and are referenced as `$BASE_PATH` / `$PAGE_URL`. A new test parses every `run:` block in both workflows (inline `- run: …` and `run: |` forms) and fails on any `${{ }}`, with a self-check that the reader actually found blocks in both files so it cannot pass vacuously. |

Also corrected: `core/rateLimit.ts` pointed at `supabase/migrations/0004_rate_limits.sql`, a file
that does not exist; the real one is `002_graphmentor_rate_limit.sql`.

## What this pass did *not* find

Worth recording, because it bounds the claim. These were checked and are sound:

- **Cypher injection.** Every query in `core/graphQuery.ts` is a constant string with bound
  `$parameters`. Variable-length depths cannot be parameterised in Cypher, so they switch between
  pre-written variants on a zod-validated integer, and labels come from an allow-list keyed on a
  validated id prefix. No user text reaches query construction.
- **SQL injection.** Every query in `server/server.ts` is parameterised, including the
  multi-statement transactional paths.
- **XSS.** No `dangerouslySetInnerHTML`, `innerHTML`, `document.write` or `new Function` in
  application code; `tests/unit/hardening-invariants.test.ts` already scans for all of them and
  correctly excludes the seed dataset's quiz strings, which mention `innerHTML` as a *wrong
  answer*.
- **Dependencies.** `npm audit` reports zero known vulnerabilities across all severities for the
  resolved tree on this date. Advisory coverage, not proof.
- **Postgres exposure.** `db/pg_hba.conf` has no `trust` and no `peer` line; every socket and
  plaintext-TCP connection is rejected; `listen_addresses` is loopback; `ssl_min_protocol_version`
  is TLSv1.2; `password_encryption` is `scram-sha-256`; `max_wal_senders` is 0.
- **Secrets.** Source and built-artifact scans are clean (381 source files, 33 bundle files,
  18/18 rule canaries). No `.env` is tracked.
- **CORS.** No bare `*` combined with `allow-credentials`; a `*` allow-list entry is deliberately
  answered with `*` and *without* credentials rather than echoed.
- **Request body handling.** Size is enforced while streaming with strict UTF-8 decoding, so a
  chunked body cannot be buffered past its advertised bound (A06).

## Verification results

| Check | Result |
| --- | --- |
| `npx vitest run` | **735 passed, 52 test files** — the 678-test baseline plus 57 new adversarial assertions in `tests/security/`. No baseline test was modified or deleted to achieve this. |
| `npm run typecheck` | Passed. |
| `npm run typecheck:functions` | Passed. |
| `npm run build` | Passed; PWA generated, 40 precache entries. Pre-existing non-fatal large-chunk warning. |
| `npm run lint:secrets` | Passed: 381 source files and 33 built files clean, 18/18 canaries. It correctly flagged the HMAC fixture in `tests/security/exploit-replay-nonce.test.ts`, which now carries the annotation the scanner documents. |
| `npm audit` | Zero known vulnerabilities. |
| `npm run lint:secrets:history` | **Incomplete:** shallow checkout in this sandbox. CI runs it at `fetch-depth: 0`. |
| `npm run verify:rls`, `npm run verify:db` | **Not verified:** no database available. They skip by name rather than passing silently. |
| Live Edge Function / Supabase / Neo4j / browser checks | Not performed; nothing was deployed. |

The GM-SEC-001 and GM-SEC-004 tests exercise the pure functions and `buildApiRequest` directly.
They verify the address-selection and key-derivation decisions, not the behaviour of a real Deno
Deploy edge in front of a real Supabase project. **Confirm the hop count against a live
deployment**: `TRUSTED_PROXY_HOPS=1` is correct for one platform proxy, and must be raised if an
operator adds their own. `/health-check` now reports the value in force.

## Remaining work for an operator

1. **Set `RATE_LIMIT_PEPPER`** (`openssl rand -hex 32`) as an Edge Function secret. Without it the
   counters still limit correctly; they are simply not the privacy-preserving table migration 002
   describes. `/health-check` reports `rateLimitKeysPeppered: false` until this is done.
2. **Confirm `TRUSTED_PROXY_HOPS` against the real deployment** and leave
   `TRUST_PROXY_HEADERS=false` unless a proxy that *overwrites* `cf-connecting-ip`/`x-real-ip` is
   genuinely in front of the functions.
3. **Do not enable `REQUIRE_REQUEST_SIGNING=true` without deploying a client that signs.** The
   contract is now correct on both sides, but `src/core/session.ts` still constructs the live
   client without a `sign` implementation, so enabling it today would reject every write from the
   shipped frontend. Pass `signClientRequest` bound to the caller's access token, as
   `handlers/shared.ts` documents.
4. **Deploy.** None of this changes a hosted site until the frontend is republished, the Edge
   Functions redeployed and the account server restarted.
5. The first audit's remaining items still stand, in particular **email-ownership verification**
   before enabling public local signup, and **provider-side Supabase Auth limits**, since
   `/auth-guard` is a browser advisory preflight that a direct call to Supabase Auth bypasses.

## Reproducing this review

```sh
npx vitest run tests/security   # the 57 adversarial assertions
npm test                        # the full 735
npm run typecheck && npm run typecheck:functions
npm run build && npm run lint:secrets
```

To see a finding fail against unmodified code, revert the corresponding source file and re-run
its test file; each header comment names the file and line the defect lived in.
