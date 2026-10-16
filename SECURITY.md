# Security policy

GraphMentor AI is a browser-first application with an optional Supabase backend. This file is
the short contract; `docs/security.md` is the long one, including the threat-by-threat table
and the code and test that address each item.

## Reporting a vulnerability

There is no production deployment and no hosting provider behind this repository, so there is
no vendor to notify. Once the repository is published, report privately through GitHub's
"Report a security vulnerability" (Security → Advisories), which keeps the report out of the
public issue tracker until a fix exists.

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
| Authentication ≠ authorization | every privileged handler re-checks ownership, not just a valid session | `supabase/functions/_shared/handlers/authGuard.ts` |

## Out of scope here

- No Android APK is built or shipped from this repository. The Capacitor configuration exists;
  no build artefact does, and no claim of one is made.
- No third-party penetration test has been performed. The table above records what the code
  does and what the repository's own tests check, not an external audit.
- The optional backend is not running here; `npm run verify:rls` and `npm run smoke:http` skip
  when `DATABASE_URL` is unset, and they say so instead of passing silently.


