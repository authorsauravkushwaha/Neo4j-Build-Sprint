/**
 * Tells zod not to use its eval-based JIT fast path.
 *
 * zod v4 compiles its hottest validators with `new Function`, and probes whether
 * it may: `allowsEval()` does a guarded `new Function("")` inside a try/catch and
 * returns false when the environment refuses. The Content-Security-Policy here
 * refuses it — `script-src 'self'` means no dynamic code generation — so the
 * probe fails, throws, is caught, and zod quietly uses its interpreter instead.
 *
 * Functionally that is already the correct outcome, and the app never noticed.
 * What it did produce was a `securitypolicyviolation` report: a strict CSP
 * reports the *attempt* even though the throw is swallowed, which is noise in the
 * console of anyone debugging the graph view and would be noise in a future
 * report collector. zod documents `jitless` as the supported way to skip the
 * probe entirely, so this module says so once, explicitly:
 *
 *   "Skip the probe under `jitless`: strict CSPs report the caught `new Function`
 *    as a `securitypolicyviolation` even though the throw is swallowed."
 *                                    — node_modules/zod/v4/core/util.js
 *
 * Only the browser needs this. The Edge Functions run in Deno with no CSP, where
 * zod's JIT path is allowed and stays enabled; that is why this is a separate
 * module imported by the browser entry rather than a setting inside the shared
 * core that both sides load.
 *
 * Import order matters: the dataset's shared modules build schemas at import
 * time, which is what triggers the probe during module evaluation — before any
 * statement in `main.tsx` runs. This module must therefore be the *first* import
 * there, so its side effect lands before those modules are evaluated.
 */
import { z } from 'zod'

z.config({ jitless: true })

export const ZOD_CONFIGURED_JITLESS = true


