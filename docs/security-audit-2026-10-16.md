# Repository security audit — 16 October 2026

## Executive conclusion

**No real-world data breach is confirmed by this review.** The repository does contain security defects and hardening gaps, remediated below. A code review cannot establish that nobody accessed production data, and a clean secret scan cannot prove that no secret ever escaped.

This review combined source inspection, adversarial regression tests, current dependency advisory checks, reachable Git-history scanning, and OWASP primary-source guidance. It is not a third-party penetration-test certification or an exhaustive guarantee.

## Scope and evidence

- Baseline: `c0653ff2ddb118f70a1cb7e0eff47865c75987f2`; changes on the existing Arena working branch.
- Reviewed the Node account server, shared Edge HTTP/security/rate-limit code, user-owned repository/handler boundaries, Supabase/Appwrite adapter boundaries, workflow network probes, browser auth/logout, PWA caching, environment handling, database policies and CI/deployment configuration.
- Fetched full available `main` history from the initially shallow checkout. The supplemental history scan covered **16 reachable commits and 496 unique text blobs**. Its provider-key/JWT/private-key rules found only **one explicitly exempted synthetic JWT in a test**; no non-exempt matches. It does not scan unreachable Git objects, other un-fetched branches, binaries or blobs over 2 MiB, and does not detect arbitrary passwords or PII. Reproduce with `npm run lint:secrets:history`.
- Source and built-artifact secret scans found no non-exempt credential-shaped strings. Reviewed the explicit test-fixture exemptions; they are not production credentials.
- `npm audit --audit-level=high` reported **zero known vulnerabilities**, including lower severities, for the resolved dependency tree on this date. This is advisory coverage, not proof that dependencies are vulnerability-free. Installation emitted deprecation warnings; deprecation alone is not a confirmed exploitable vulnerability.
- No production credentials, service access logs, user records, deployed policies or incident evidence were available. No external deployment was attacked and no credential was tested for validity.

## Remediated defects and hardening

Priorities are qualitative triage, not CVSS scores. None of these entries is evidence of prior exploitation.

| ID | Priority / category | Evidence before change | Remediation and evidence after change |
| --- | --- | --- | --- |
| A01 | High: guessing protection | `server/server.ts` trusted arbitrary `X-Forwarded-For`; login's email budget also included the supplied IP, permitting budget rotation. | Ignore forwarded headers unless explicitly trusted, use the socket peer by default, and key the email budget independently by hashed email. Limit state is per-server, expires old entries, is bounded and refuses new keys at capacity instead of evicting active budgets. HTTP regression rotates forged addresses and verifies throttling. |
| A02 | High: sensitive reauthentication | Password-change and account-deletion paths verified unlimited guesses; current/delete passwords did not have the login byte ceiling. | Shared per-user reauthentication budget (8/10 minutes), 72-byte input ceiling before credential verification, and regression covering both endpoints. |
| A03 | Medium: session transport | `Secure` depended on untrusted forwarded protocol and was absent by default; forwarded host was accepted without an explicit trust decision. | Cookies are Secure by default, with an explicit local-HTTP opt-out. Forwarded host is ignored by default; Vite preserves original Host for same-origin checks. HTTP tests cover cookie flags and forged forwarded host. |
| A04 | Medium: account disclosure / integrity | Existing registration returned 200/null; fresh registration returned 201/user/session cookie. Identity and credentials were separate non-transactional writes. Overlong emails were silently truncated. | Generic identical registration response, no automatic session, hashing work on both paths, transactional identity/credential creation with conflict-safe insertion, and no email truncation. Tests verify identical responses and rollback. **Email ownership verification remains a deployment requirement; see below.** |
| A05 | High in privileged CLI/server contexts: outbound-policy bypass | Workflow URL validation checked only the initial host, but the fetch probe followed redirects. | Disable redirect following, omit ambient credentials, and reject IP literals, local/internal hosts and nonstandard ports even if declared in workflow settings. Resource links also reject IPv6 literals/nonstandard ports. Regression checks fetch options and hostile URL forms. This is not a complete DNS-rebinding defense. |
| A06 | Medium: resource exhaustion | Edge HTTP wrapper used `request.text()` before checking size; chunked bodies could be buffered without the advertised bound. | Count bytes while streaming, cancel at the ceiling, and strictly decode UTF-8, including split multi-byte characters. Tests cover cancellation and malformed/split UTF-8. |
| A07 | High for cost/abuse budgets: limiter failure modes | API counters failed open on store errors. Deno fallback memory counters/nonces could be freshly created for each request when no shared store was wired. | API counters fail closed with a safe dependency error. Local/read-only Deno stores are reused per isolate. Hosted Supabase without its shared privileged store fails closed rather than silently using request-local state. Counter failure regression updated. Supabase's advisory auth preflight still explicitly fails open because provider Auth is a separate direct endpoint. |
| A08 | Medium: logout correctness | `localSignOut()` swallowed network errors; UI claimed the session had been deleted even when revocation failed. | Return explicit outcome, leave the account UI signed in on failure and warn the user to retry. Client regression covers offline, server rejection and acknowledged success. |
| A09 | Defense in depth: persistent API caching | Service-worker runtime rule matched every anonymous `/functions/v1/` GET and cached based on status, not an explicitly public response policy. | Remove API runtime caching; keep static-asset offline support. Activation migration deletes the retired `gm-public-api-v1` cache. Regression pins the policy/migration. **No actual private response in that cache was demonstrated.** |
| A10 | Defense in depth: secret detection / CI | Every `.env.example` match was exempt, assigned environment secrets were incompletely matched, encrypted Neo4j URLs were missed, and deployment scanned source before—not the final bundle after—building. | Remove blanket example-file exemption, add quoted/unquoted environment-secret and encrypted-URL rules, expand canary from 14 to 18 cases, scan final artifacts before upload, add reachable-history scan and a high-severity dependency gate in CI. CI token defaults are read-only. |
| A11 | Low: malformed input / response hygiene | Malformed cookie escaping could throw; local Node API lacked the shared security-header baseline. | Ignore malformed cookie values, use a null-prototype cookie map, and add nosniff/no-referrer/frame denial headers. HTTP regression covers malformed cookies and headers. |

## Verification results

| Check | Result |
| --- | --- |
| `npm test -- --reporter=dot` | **678 passed, 47 test files**; includes 22 new audit/logout/cache regressions. Existing React `act(...)` warnings remain non-failing. |
| `npm run build` | Passed; includes application/Node typechecking and production PWA generation. Non-fatal existing large-chunk warning. |
| `npm run typecheck:functions` | Passed. |
| `npm run check:bundle` | Passed. |
| `npm run lint:secrets` after build | Passed; 18/18 rule canaries; built artifact scanned. |
| `npm run lint:secrets:history` | Passed with the scope/fixture exception stated above. |
| `npm audit --audit-level=high` | Zero known vulnerabilities. |
| `npm run audit:self` | 25/25 passed; refreshed `docs/security-self-audit.md`. These probes are limited and do not supersede this report. |
| `npm run verify:rls` | **Not verified:** command refused because `DATABASE_URL` is absent. |
| `npm run verify:db` | **Not verified:** no provisioned cluster at `/srv/graphmentor-pg/data`. |
| Live deployed browser / Edge / backend checks | Not performed; no deployment configuration or production access supplied. |

The real-HTTP account regressions use an injected database stub. They verify HTTP decisions and transaction calls, not actual PostgreSQL grants, constraints or RLS. The existing Appwrite/Supabase tests also use adapters/fakes; deployed permissions must still be checked against real services.

## Deployment changes and remaining work

1. **Deploy the fixes.** Repository edits do not change an already hosted site. Publish the frontend, activate the updated service worker, deploy Edge Functions and restart the account server. The cache migration runs only when the new worker activates; clients remaining on the old worker have not received it. This review did not deploy anything.
2. **Keep HTTPS and proxy trust explicit.** Cookies are Secure by default. Only for local plain HTTP, use `AUTH_ALLOW_INSECURE_HTTP=true npm run server`. Keep `AUTH_TRUST_PROXY` unset behind the supplied Vite proxy. If enabling it for production ingress, overwrite incoming forwarded headers and block direct backend access. Behind default Vite, network budgets conservatively share the proxy's socket address; per-email budgets remain independent.
3. **Provision shared state.** Hosted Supabase must provide `SUPABASE_SERVICE_ROLE_KEY` server-side and apply the counter/nonce migrations. Local in-memory limits reset on restart and do not span replicas. Deploy a shared atomic limiter before scaling the local account server; per-isolate read-only limits are likewise not global.
4. **Verify email ownership before production identity use.** The local account system accepts unverified email. Equal registration responses remove the immediate response oracle, but signup followed by a chosen-password login can still distinguish a newly registered address from an existing one. It also cannot prevent address squatting without verification. Use the verified hosted auth path (with email confirmations enabled), or implement delivery-backed confirmation before enabling local public signup. No email-delivery service was available here. The application is not claiming an email-confirmation feature it does not have.
5. **Enforce provider-side Auth limits.** `/auth-guard` is a browser advisory preflight and is bypassable by calling Supabase Auth directly. Its byte-count and fingerprint fields are caller-supplied, not server evidence. Supabase Auth's own rate limits, confirmations, password policy and optionally MFA/CAPTCHA must be configured. Its fail-open behavior is not represented as a security boundary.
6. **Constrain network egress.** The workflow definitions/allowed hosts are operator-reviewed configuration, not permission grants from untrusted users. URL checks and no redirects do not pin DNS resolution to a public destination. Before allowing arbitrary imported workflows in a privileged server/CLI, enforce public-destination DNS/connection validation or an egress gateway that denies loopback, private, link-local and metadata networks. Do not treat a workflow-authored host list as an independent administrator policy.
7. **Verify deployed databases and backups.** Run RLS and database harnesses on owned test infrastructure, then validate deployed grants and owner isolation. Check Supabase/Appwrite collection permissions, Neo4j credentials, TLS, backup encryption and access controls. Do not run destructive harnesses against production user data.
8. **Investigate any suspected incident separately.** Preserve logs and snapshots; examine auth, exports, database queries, provider key usage, CI artifacts and historical releases for the exposure period. If a credential may have escaped, revoke/rotate it and invalidate affected sessions first. Deleting a key from source does not revoke it. No rotation was performed because no real leaked credential was identified and no provider administration access was supplied.
9. **Review shared-device storage.** Guest/device profiles and downloaded account data intentionally persist until erased; sign-out does not erase those offline copies. Supabase's browser session persistence also remains a separate XSS/shared-device trade-off. Use device-data erasure before handing over a shared device; a repository scan cannot erase other browsers.

## Research basis

Primary guidance consulted on 16 October 2026, applied to the concrete code paths above:

- [OWASP Authentication Cheat Sheet](https://github.com/OWASP/CheatSheetSeries/blob/684d6d9d9f1a0c680ad30219f46ae4e2debf9440/cheatsheets/Authentication_Cheat_Sheet.md): generic responses must account for status/body differences, and throttling should not rely solely on an easily rotated source address. This informed A01–A04; it does not certify the implementation or replace email verification.
- [OWASP SSRF Prevention Cheat Sheet](https://github.com/OWASP/CheatSheetSeries/blob/5a2c4d9dc550d583f80b7e2fb8e4aba98019364f/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md): disable automatic redirects to prevent validation bypass; apply both application and network controls. This informed A05 and the explicit DNS/egress limitation.
- npm registry advisory results from the checked lockfile, rather than assuming that updating every package to a newer major version is a security fix.

**Bottom line:** verified repository-level fixes and repeatable checks are provided. “Every breach found and fixed” would be an unsupported claim without production evidence and the operational checks above.
