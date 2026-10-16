#!/usr/bin/env node
/**
 * run-oracle — regenerate the cross-language fixture, compile the Java oracle,
 * and run it twice: once to compare, once to prove the comparison can fail.
 *
 *   npm run oracle
 *
 * Why the fixture is regenerated here rather than trusted from disk: the expected
 * values must come from the TypeScript engine *as it is right now*. A committed
 * fixture that nobody regenerates decays into a file that agrees with a version of
 * the code that no longer exists, which is exactly the kind of green tick that
 * means nothing. So the chain is: export from TypeScript, recompute in Java,
 * compare, then corrupt the expectation in memory and require the diff to notice.
 *
 * Java is a hard requirement for this step. It is not silently optional: if no
 * JDK is present the script says so and exits non-zero. `npm run verify` decides
 * separately whether to skip the step on a machine without Java — and says so in
 * its summary rather than counting a skip as a pass.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = resolve(root, 'tools/oracle/build')
const fixture = resolve(root, 'tools/oracle/fixtures/frontier-oracle.tsv')
const source = resolve(root, 'tools/oracle/FrontierOracle.java')

function run (command, label, extra = {}) {
  const result = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, ...extra } })
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status ?? 'null'}).`)
    process.exit(result.status ?? 1)
  }
}

// 1. Is a JDK actually here? Checked by running it, never assumed from a path.
const javacVersion = spawnSync('javac -version', { cwd: root, shell: true, encoding: 'utf8' })
if (javacVersion.status !== 0) {
  console.error('Cross-language oracle needs a JDK: `javac` was not found on PATH.')
  console.error('Install a JDK (11 or newer) and rerun, or skip this step — but do not count it as passing.')
  process.exit(1)
}

// 2. Export the fixture from the TypeScript engine.
run('npx tsx scripts/export-frontier-fixture.ts', 'Fixture export')

// 3. The fixture has to be substantial before a "match" means anything. A fixture
//    that quietly exported no cases would let the oracle print MATCH on nothing.
if (!existsSync(fixture)) {
  console.error(`Fixture was not written: ${fixture}`)
  process.exit(1)
}
const text = readFileSync(fixture, 'utf8')
const cases = (text.match(/^#case /gm) ?? []).length
const expectedLines = (text.match(/^(COUNT|SUMMARY|HOURS|WEEKS|FRONTIER|GATES|CHAIN|DEPTHS|REMAINING|PULLED|CYCLIC|CAVEATS)\t/gm) ?? []).length
if (cases < 5 || expectedLines < 60) {
  console.error(`Fixture looks too small to prove anything: ${cases} case(s), ${expectedLines} expected line(s).`)
  process.exit(1)
}
console.log(`\nFixture: ${cases} case(s), ${expectedLines} expected line(s), ${(statSync(fixture).size / 1024).toFixed(0)} KiB.`)

// 4. Compile. `-encoding UTF-8` is not optional: the file is UTF-8 and javac
//    otherwise assumes the platform charset and dies on the first em dash.
run(`javac -encoding UTF-8 -Xlint:all -d ${JSON.stringify(buildDir)} ${JSON.stringify(source)}`, 'javac')
console.log(`\nCompiled: ${(javacVersion.stdout ?? '').trim()} -> tools/oracle/build`)

// 5. Compare, then prove the comparison can fail.
run(`java -Dfile.encoding=UTF-8 -cp ${JSON.stringify(buildDir)} FrontierOracle`, 'Oracle comparison')
run(`java -Dfile.encoding=UTF-8 -cp ${JSON.stringify(buildDir)} FrontierOracle --selftest`, 'Oracle self-test')
console.log('\nCross-language oracle: match, and the self-test confirmed the diff detects an injected error.')


