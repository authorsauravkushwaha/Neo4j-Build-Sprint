/**
 * Canary fixtures for the secret scanner.
 *
 * A scanner that quietly stops matching is worse than no scanner: the green
 * output still reads as "no credentials here". So `scripts/scan-secrets.mjs`
 * feeds itself these fixtures on every run and fails if any is classified
 * wrongly — planted secrets that must be caught, and genuine placeholders that
 * must not be flagged.
 *
 * Each fixture's text is assembled at runtime instead of being written literally,
 * because the scanner reads this very file: `pair('password', 'hunter2hunter2')`
 * contains no `password = "<value>"` shape on its own line, so the canary never
 * has to exempt itself from the rules it is testing. If you add a fixture, keep
 * that property, or the canary starts tripping its own scan.
 */

/** `name = "value"` — the shape the assigned-secret rule looks for. */
const pair = (name, value) => `${name} = "${value}"`

/** Join fragments without writing the joined shape in source. */
const glue = (...parts) => parts.join('')

export const CANARY_FIXTURES = [
  // ---------------------------------------------------------------- must catch
  {
    label: 'a password assigned a non-placeholder value',
    fixture: pair('password', 'hunter2hunter2'),
    expect: 'caught',
  },
  {
    label: 'a secret assigned 19 characters',
    fixture: pair('secret', glue('abcdef123', '456789xyz')),
    expect: 'caught',
  },
  {
    label: 'an access token assigned an opaque blob',
    fixture: pair('access_token', glue('abc123def', '456ghi789')),
    expect: 'caught',
  },
  {
    label: 'a provider-style API key',
    fixture: pair('api_key', glue('sk-live-', 'abcdefghijklmnop')),
    expect: 'caught',
  },
  {
    label: 'a JSON Web Token',
    fixture: glue('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'abcdefghijklmnop'),
    expect: 'caught',
  },
  {
    label: 'a PEM private key header',
    fixture: glue('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
    expect: 'caught',
  },
  {
    label: 'a connection string with an inline password',
    fixture: glue('neo4j:', '//svc:', 'hunter2hunter2', '@db.neo4j.io'),
    expect: 'caught',
  },

  {
    label: 'a provider key in an example environment file is not exempt',
    fixture: glue('AI_API_KEY=', 'sk-live-', 'abcdefghijklmnop'),
    file: '.env.example',
    expect: 'caught',
  },
  {
    label: 'an unquoted environment password',
    fixture: glue('NEO4J_PASSWORD=', 'hunter2hunter2'),
    file: '.env.local.example',
    expect: 'caught',
  },
  {
    label: 'credentials in an encrypted Neo4j URL',
    fixture: glue('neo4j+s:', '//svc:', 'hunter2hunter2', '@db.neo4j.io'),
    expect: 'caught',
  },

  {
    label: 'a quoted environment password',
    fixture: glue('NEO4J_PASSWORD=', '"', 'hunter2hunter2', '"'),
    file: '.env.example',
    expect: 'caught',
  },

  // -------------------------------------------------------------- must allow
  {
    label: 'a REPLACE_WITH placeholder',
    fixture: pair('password', 'REPLACE_WITH_YOUR_PASSWORD'),
    expect: 'allowed',
  },
  {
    label: 'a "your own password" placeholder',
    fixture: pair('password', 'your-own-password'),
    expect: 'allowed',
  },
  {
    label: 'an angle-bracket placeholder',
    fixture: pair('api_key', glue('<', 'your-api-key', '>')),
    expect: 'allowed',
  },
  {
    label: 'a value read from the environment',
    fixture: pair('password', 'process.env.GM_PASSWORD'),
    expect: 'allowed',
  },
  {
    label: 'an env-var interpolation',
    fixture: pair('GM_TOKEN', glue('${', 'GM_TOKEN', '}')),
    expect: 'allowed',
  },
  {
    label: 'a change-me placeholder',
    fixture: pair('password', 'change-me-please'),
    expect: 'allowed',
  },
  {
    label: 'a minified bundle echoing a key name as its value',
    fixture: glue('access_token:', '"access_token"'),
    expect: 'allowed',
  },
]


