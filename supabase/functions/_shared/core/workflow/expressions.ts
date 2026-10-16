/**
 * The expression language: `{{ … }}` references, evaluated without `eval`.
 *
 * n8n's expressions are JavaScript, evaluated in a sandbox. This project cannot
 * do that, for a reason that is worth stating plainly: the values flowing through
 * a workflow include text typed by a user (a mentor question, a note) and text
 * fetched from the network (a resource title). Handing either to `new Function`
 * is a remote-code-execution hole with a friendly syntax, and "it is only our own
 * workflow files" stops being true the moment a workflow is imported.
 *
 * So this is a *reference* language, not a scripting one:
 *
 *   {{ $json.title }}                 current item's field
 *   {{ $json.items[0].name }}         array index
 *   {{ $node["Fetch"].json.status }}  another node's first item
 *   {{ $now }}  {{ $workflow.id }}    run metadata
 *   {{ $count }}                      how many items the previous node produced
 *
 * Anything else is a compile error surfaced to the user before the run starts.
 * There are no function calls, no property assignment, no operators and no
 * coercion rules to memorise. The grammar is small enough to hold in one head,
 * which is the point: a workflow file should be reviewable by the person who has
 * to trust its output.
 *
 * A reference that cannot be resolved renders as an empty string and is recorded
 * as a warning — never as the literal `{{ … }}`, which would silently publish a
 * template into a digest.
 */

export interface ExpressionScope {
  /** The item currently being processed. */
  json: Record<string, unknown>
  /** Outputs of earlier nodes, keyed by node name: the first item of each. */
  nodes: Record<string, Record<string, unknown>>
  now: number
  workflowId: string
  /** Number of items the previous node produced. */
  count: number
}

export interface ExpressionResult {
  value: string
  /** References that could not be resolved. Empty when everything resolved. */
  unresolved: string[]
}

const REFERENCE = /^\s*(?:\$json|\$node\["([^"]+)"\]\.json|\$now|\$workflow\.id|\$count)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)\s*$/

/** Splits `a.b[0].c` into ['a','b','0','c']. */
function pathParts(path: string): string[] | null {
  if (path === '') return []
  const parts: string[] = []
  const pattern = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(path)) !== null) {
    if (match.index !== index) return null
    parts.push(match[1] ?? match[2] ?? '')
    index = pattern.lastIndex
  }
  return index === path.length ? parts : null
}

/** Reads a dotted path off a value, refusing anything that is not plain data. */
function readPath(root: unknown, parts: string[]): unknown {
  let current: unknown = root
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    // Only own properties, and never the prototype chain: `{{ $json.__proto__ }}`
    // must not be able to walk into anything.
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** A value as text, and never `[object Object]`. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(stringifyValue).filter((entry) => entry !== '').join(', ')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** Resolves one reference. Exported for the tests, which pin the grammar. */
export function resolveReference(reference: string, scope: ExpressionScope): { found: boolean; value: unknown } {
  const match = REFERENCE.exec(reference)
  if (!match) return { found: false, value: undefined }
  const [, nodeName] = match
  const parts = pathParts(match[2] ?? '')
  if (parts === null) return { found: false, value: undefined }

  if (nodeName !== undefined) {
    const nodeOutput = scope.nodes[nodeName]
    if (nodeOutput === undefined) return { found: false, value: undefined }
    return { found: true, value: readPath(nodeOutput, parts) }
  }

  const head = reference.trim().split(/[.[\s]/)[0]
  if (head === '$json') return { found: true, value: readPath(scope.json, parts) }
  if (head === '$now') return { found: true, value: parts.length === 0 ? new Date(scope.now).toISOString() : undefined }
  if (head === '$count') return { found: true, value: parts.length === 0 ? scope.count : undefined }
  if (head === '$workflow') return { found: true, value: readPath({ id: scope.workflowId }, parts) }
  return { found: false, value: undefined }
}

/**
 * Renders a parameter value.
 *
 * Non-string values are returned untouched, and a string that is *exactly* one
 * reference keeps the referenced value's type (`{{ $json.count }}` stays a
 * number). That matters for node parameters like `limit`, where a template that
 * produced the string "5" would otherwise be rejected by validation.
 */
export function evaluate(value: unknown, scope: ExpressionScope): { value: unknown; unresolved: string[] } {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      const unresolved: string[] = []
      const out = value.map((entry) => {
        const result = evaluate(entry, scope)
        unresolved.push(...result.unresolved)
        return result.value
      })
      return { value: out, unresolved }
    }
    if (value !== null && typeof value === 'object') {
      const unresolved: string[] = []
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const result = evaluate(entry, scope)
        unresolved.push(...result.unresolved)
        out[key] = result.value
      }
      return { value: out, unresolved }
    }
    return { value, unresolved: [] }
  }

  const whole = /^\s*\{\{([^{}]*)\}\}\s*$/.exec(value)
  if (whole) {
    const resolved = resolveReference(whole[1] ?? '', scope)
    if (!resolved.found) return { value: '', unresolved: [whole[1]?.trim() ?? ''] }
    // An unresolved path inside a valid reference is still a problem worth
    // reporting, even though the render is an empty string.
    if (resolved.value === undefined) return { value: '', unresolved: [whole[1]?.trim() ?? ''] }
    return { value: resolved.value, unresolved: [] }
  }

  const unresolved: string[] = []
  const rendered = value.replace(/\{\{([^{}]*)\}\}/g, (_all, reference: string) => {
    const resolved = resolveReference(reference, scope)
    if (!resolved.found || resolved.value === undefined) {
      unresolved.push(reference.trim())
      return ''
    }
    return stringifyValue(resolved.value)
  })
  return { value: rendered, unresolved }
}

/** True when the string contains at least one reference. */
export function hasExpression(value: unknown): boolean {
  return typeof value === 'string' && /\{\{[^{}]*\}\}/.test(value)
}

/**
 * Validates every expression in a parameter map before a run starts.
 *
 * The failure mode this exists to prevent: a workflow is saved with
 * `{{ $node["Resouces"].json.name }}` (a typo), the reference never resolves,
 * and the digest that goes out has a blank line where a resource name should be.
 * Catching it at load time turns a silent, wrong output into a refused run with
 * a message naming the node and the reference.
 */
export function validateExpressions(
  nodeName: string,
  parameters: Record<string, unknown>,
): Array<{ node: string; parameter: string; reference: string; reason: string }> {
  const problems: Array<{ node: string; parameter: string; reference: string; reason: string }> = []
  const walk = (parameter: string, value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const reference = (match[1] ?? '').trim()
        if (!REFERENCE.test(reference)) {
          problems.push({
            node: nodeName,
            parameter,
            reference,
            reason: 'not a supported reference; see the grammar in core/workflow/expressions.ts',
          })
        }
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${parameter}[${index}]`, entry))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walk(`${parameter}.${key}`, entry)
    }
  }
  for (const [parameter, value] of Object.entries(parameters)) walk(parameter, value)
  return problems
}
