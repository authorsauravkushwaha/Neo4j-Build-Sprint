# Security policy

GraphMentor AI is a browser-first application with selectable Node, Supabase Edge Functions, and bundled demo paths. This file is the short security contract; `docs/security.md` is the long one, including the threat-by-threat table and the code and test that address each item. The supported data paths are described in `docs/architecture.md`.

Two audit passes have been run against this repository, both white-box and both remediated:
`docs/security-audit-2026-10-16.md` (A01–A11) and
`docs/security-audit-round2-2026-10-16.md` (GM-SEC-001–005). The second pass exists because the
first remediated two classes of defect in one of the two places each appeared; the adversarial
tests it added live in `tests/security/`. Neither pass is a third-party penetration test, and
neither attacked a live deployment — there was none.

## Reporting a vulnerability

This repository does not establish whether a production deployment currently exists or has been audited. Report code vulnerabilities privately through GitHub's "Report a security vulnerability" (Security → Advisories), which keeps the report out of the public issue tracker until a fix exists. For a deployed service, also follow its hosting provider's incident process.

Please include: what you did, what you expected, what happened, and the smallest reproduction
you can manage. Do not attach real credentials or personal data.

**Do not** test against accounts, data or infrastructure you do not own. There are no other
users' accounts on any instance run from this repository — guest mode is local-only — but the
rule still applies to any deployment you do not control.

## What this codebase defends, and where

| Class | Where it is addressed | Where it is tested |
| --- | --- | --- |
| Replay of privileged requests | single-use, time-boxed nonces (`supabase/functions/_shared/core/security.ts`) | `tests/unit/security.test.ts` |
| Clipboard snooping | copy actions are explicit, user-initiated, and never carry secrets | `docs/security.md` §clipboard |
| SQL / NoSQL injection | parameterised Postgres via the Supabase client; no string-built queries; Cypher is parameterised and MERGE-only | `tests/unit/validate.test.ts`, `scripts/validate-seed.ts` §Cypher audit |
| Secret-key leakage | anon key only in the client; service-role key never shipped; scanner over `src/` and `dist/` | `npm run lint:secrets`, `scripts/scan-secrets.mjs` |
| Long-password DoS | password length and character-class limits before hashing | `tests/unit/validate.test.ts` |
| ReDoS | all validation patterns are linear-time; no nested quantifiers over user input | `tests/unit/validate.test.ts` |
| SSTI | no template engine runs over user input (deterministic string builders only) | `scripts/audience/README.md` (method notes) |
| Error handling & information leakage | one error shape, no stack traces or SQL details to clients | `supabase/functions/_shared/core/errors.ts` |
| File upload | no upload endpoint exists; stated as not applicable | `docs/security.md` |
| Secret management | `.env` files are git-ignored; no secrets in `localStorage`; example env documents names only | `.gitignore`, `docs/security.md` |
| Input validation | one schema layer (zod) at every handler boundary | `tests/unit/validate.test.ts`, `tests/integration/handlers.test.ts` |
| Rate limiting | per-route token buckets with honest responses | `supabase/functions/_shared/core/rateLimit.ts` |
| Caller address is not caller-chosen | forwarded headers disbelieved by default; `x-forwarded-for` read from the right by `TRUSTED_PROXY_HOPS` (`clientIpFromHeaders`) | `tests/security/exploit-client-ip.test.ts` |
| Rate-limit keys hold no recoverable identity | HMAC under `RATE_LIMIT_PEPPER`, reported as `rateLimitKeysPeppered` on `/health-check` | `tests/security/exploit-bucket-key.test.ts` |
| Replay signatures bind the nonce | one canonical string shared by browser and Edge Function (`signClientRequest`) | `tests/security/exploit-replay-nonce.test.ts` |
| Outbound workflow probes stay on the allow-list | one probe implementation, `redirect: 'error'` + `credentials: 'omit'` | `tests/security/exploit-workflow-probe.test.ts` |
| CI does not hand event data to a shell | no `${{ }}` inside any `run:` block; values arrive via `env:` | `tests/security/exploit-ci-injection.test.ts` |
| Authentication ≠ authorization | every privileged handler re-checks ownership, not just a valid session | `supabase/functions/_shared/handlers/authGuard.ts` |

## Out of scope here

- No Android APK is built or shipped from this repository. The Capacitor configuration exists;
  no build artefact does, and no claim of one is made.
- No third-party penetration test has been performed. The table above records what the code
  does and what the repository's own tests check, not an external audit.
- The optional backend is not running here; `npm run verify:rls` and `npm run smoke:http` skip
  when `DATABASE_URL` is unset, and they say so instead of passing silently.


