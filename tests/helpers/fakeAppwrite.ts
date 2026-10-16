/**
 * An in-memory emulation of the Appwrite document API, for the adapter tests.
 *
 * Why not stub the client interface directly: `createAppwriteClient` is the code
 * under test, and most of what can go wrong in it is wire-level — a filter that
 * never reaches the request, a query string Appwrite would reject, an upsert that
 * creates a duplicate because it looked for the wrong document, a paginated read
 * that stops one page early. Stubbing `SupabaseLikeClient` would replace exactly
 * the layer where those bugs live.
 *
 * So this implements the subset of the REST API the adapter uses — list with
 * `queries[]`, create with `documentId`, patch, delete, `/account` — plus the
 * parts that make it a real test: unique indexes are enforced from
 * `appwriteSchema.ts`, required attributes are enforced, ids are refused if they
 * already exist, and `x-total-count` can be withheld to force the counting
 * fallback.
 */
import type { AppwriteRequest, AppwriteResponse, AppwriteTransport } from '../../supabase/functions/_shared/platform/appwrite.ts'
import { collectionFor, type AppwriteCollection } from '../../supabase/functions/_shared/platform/appwriteSchema.ts'

export type FakeDocument = Record<string, unknown>

export interface FakeFailure {
  status: number
  message?: string
  type?: string
  methods?: AppwriteRequest['method'][]
  pathIncludes?: string
  /** How many matching requests to fail before succeeding again. Default 1. */
  times?: number
}

export interface FakeAppwrite {
  transport: AppwriteTransport
  /** Every request the adapter made, in order. */
  requests: AppwriteRequest[]
  seed(collection: string, documents: FakeDocument[]): void
  documents(collection: string): FakeDocument[]
  /** Registers a session secret and returns it. */
  openSession(userId: string, options?: { email?: string }): string
  failNext(failure: FakeFailure): void
  /** Withhold `x-total-count`, forcing the adapter to count by paging. */
  setTotalCountHeader(present: boolean): void
  reset(): void
}

interface ParsedQuery {
  name: string
  args: unknown[]
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const randomId = (length = 20): string =>
  Array.from({ length }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]).join('')

/** Parses `equal("user_id",["abc"])` into `{name: 'equal', args: ['user_id', ['abc']]}`. */
function parseQuery(text: string): ParsedQuery | null {
  const match = /^([a-zA-Z]+)\((.*)\)$/.exec(text)
  if (!match) return null
  const name = match[1]!
  const args = match[2]!.trim()
  if (args === '') return { name, args: [] }
  try {
    const parsed = JSON.parse(`[${args}]`) as unknown[]
    return { name, args: parsed }
  } catch {
    throw new Error(`The fake Appwrite API cannot parse the query "${text}"`)
  }
}

const looselyEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  return String(a) === String(b)
}

const matchesQueries = (document: FakeDocument, parsed: ParsedQuery[]): boolean => {
  for (const { name, args } of parsed) {
    const attribute = String(args[0])
    const values = args[1]
    if (name === 'select' || name.startsWith('order') || name === 'limit' || name === 'offset') continue
    if (name === 'equal') {
      const list = Array.isArray(values) ? values : [values]
      if (!list.some((value) => looselyEqual(document[attribute], value))) return false
      continue
    }
    if (name === 'isNull') {
      if (document[attribute] !== null && document[attribute] !== undefined) return false
      continue
    }
    if (name === 'isNotNull') {
      if (document[attribute] === null || document[attribute] === undefined) return false
      continue
    }
    if (name === 'lessThan') {
      const bound = new Date(String(Array.isArray(values) ? values[0] : values)).getTime()
      const actual = new Date(String(document[attribute])).getTime()
      if (!(actual < bound)) return false
      continue
    }
    throw new Error(`The fake Appwrite API does not implement the query "${name}()"`)
  }
  return true
}

const missingRequired = (collection: AppwriteCollection, document: FakeDocument): string[] =>
  collection.attributes
    .filter((attribute) => attribute.required)
    .filter((attribute) => document[attribute.key] === undefined || document[attribute.key] === null)
    .map((attribute) => attribute.key)

function uniqueViolation(collection: AppwriteCollection, documents: FakeDocument[], candidate: FakeDocument): string | null {
  for (const index of collection.indexes) {
    if (index.type !== 'unique') continue
    const clash = documents.some((document) => index.attributes.every((attribute) => looselyEqual(document[attribute], candidate[attribute])))
    if (clash) return index.key
  }
  return null
}

export function createFakeAppwrite(): FakeAppwrite {
  const tables = new Map<string, FakeDocument[]>()
  const sessions = new Map<string, { userId: string; email: string | null }>()
  const requests: AppwriteRequest[] = []
  const failures: FakeFailure[] = []
  let totalCountHeader = true

  const bucketFor = (collection: string): FakeDocument[] => {
    const existing = tables.get(collection)
    if (existing) return existing
    const created: FakeDocument[] = []
    tables.set(collection, created)
    return created
  }

  const body = (request: AppwriteRequest): Record<string, unknown> => (request.body ?? {}) as Record<string, unknown>

  const respond = (status: number, payload: unknown, total?: number): AppwriteResponse => ({
    status,
    body: payload,
    headers: {
      'content-type': 'application/json',
      ...(totalCountHeader && total !== undefined ? { 'x-total-count': String(total) } : {}),
    },
  })

  const failureFor = (request: AppwriteRequest): FakeFailure | null => {
    const index = failures.findIndex(
      (failure) =>
        (!failure.methods || failure.methods.includes(request.method)) &&
        (!failure.pathIncludes || request.path.includes(failure.pathIncludes)),
    )
    if (index === -1) return null
    const failure = failures[index]!
    if ((failure.times ?? 1) <= 1) failures.splice(index, 1)
    else failure.times = (failure.times ?? 1) - 1
    return failure
  }

  const error = (status: number, type: string, message: string): AppwriteResponse => respond(status, { code: status, type, message })

  const transport: AppwriteTransport = async (request) => {
    requests.push(request)
    const failure = failureFor(request)
    if (failure) {
      return error(failure.status, failure.type ?? 'general_argument_invalid', failure.message ?? 'scripted failure')
    }

    if (request.path === '/account') {
      const session = request.session ?? ''
      const account = sessions.get(session)
      if (!account) return error(401, 'user_unauthorized', 'The current user is not authorized to perform the requested action.')
      return respond(200, { $id: account.userId, email: account.email, $createdAt: new Date().toISOString() })
    }

    const list = /^\/databases\/([^/]+)\/collections\/([^/]+)\/documents$/.exec(request.path)
    if (list) {
      const collectionId = list[2]!
      const collection = collectionFor(collectionId)
      if (!collection) return error(404, 'collection_not_found', `Collection ${collectionId} does not exist.`)
      const documents = bucketFor(collectionId)
      const parsed = (request.query ?? []).map(parseQuery).filter((entry): entry is ParsedQuery => entry !== null)

      if (request.method === 'GET') {
        const matched = documents.filter((document) => matchesQueries(document, parsed))
        for (const { name, args } of parsed) {
          if (name === 'orderAsc' || name === 'orderDesc') {
            const attribute = String(args[0])
            matched.sort((left, right) => {
              const a = String(left[attribute] ?? '')
              const b = String(right[attribute] ?? '')
              return name === 'orderAsc' ? (a < b ? -1 : a > b ? 1 : 0) : a > b ? -1 : a < b ? 1 : 0
            })
          }
        }
        const offset = parsed.find((entry) => entry.name === 'offset')
        const limit = parsed.find((entry) => entry.name === 'limit')
        const start = offset ? Number(offset.args[0]) : 0
        const size = limit ? Number(limit.args[0]) : matched.length
        return respond(200, { total: matched.length, documents: matched.slice(start, start + size) }, matched.length)
      }

      if (request.method === 'POST') {
        const payload = body(request)
        const attributes = (payload.data ?? {}) as FakeDocument
        const documentId = typeof payload.documentId === 'string' && payload.documentId ? payload.documentId : randomId()
        if (documents.some((document) => document.$id === documentId)) {
          return error(409, 'document_already_exists', `Document with the requested ID ${documentId} already exists.`)
        }
        const candidate: FakeDocument = { ...attributes, $id: documentId }
        const missing = missingRequired(collection, candidate)
        if (missing.length > 0) {
          return error(400, 'attribute_required', `Missing required attributes: ${missing.join(', ')}.`)
        }
        const clash = uniqueViolation(collection, documents, candidate)
        if (clash) return error(409, 'document_already_exists', `A document already exists for the unique index ${clash}.`)
        const now = new Date().toISOString()
        const stored: FakeDocument = { $id: documentId, $createdAt: now, $updatedAt: now, ...attributes }
        documents.push(stored)
        return respond(201, stored)
      }
      return error(405, 'general_route_not_found', `${request.method} is not supported on a collection path.`)
    }

    const single = /^\/databases\/([^/]+)\/collections\/([^/]+)\/documents\/([^/]+)$/.exec(request.path)
    if (single) {
      const collectionId = single[2]!
      const documentId = decodeURIComponent(single[3]!)
      const documents = bucketFor(collectionId)
      const index = documents.findIndex((document) => document.$id === documentId)
      if (index === -1) {
        return error(404, 'document_not_found', `Document with the requested ID ${documentId} could not be found.`)
      }
      if (request.method === 'PATCH') {
        const attributes = body(request)
        const merged: FakeDocument = { ...documents[index]!, ...attributes, $updatedAt: new Date().toISOString() }
        const collection = collectionFor(collectionId)
        if (collection) {
          const missing = missingRequired(collection, merged)
          if (missing.length > 0) return error(400, 'attribute_required', `Missing required attributes: ${missing.join(', ')}.`)
          const others = documents.filter((_, position) => position !== index)
          const clash = uniqueViolation(collection, others, merged)
          if (clash) return error(409, 'document_already_exists', `A document already exists for the unique index ${clash}.`)
        }
        documents[index] = merged
        return respond(200, merged)
      }
      if (request.method === 'DELETE') {
        documents.splice(index, 1)
        return respond(204, null)
      }
      if (request.method === 'GET') {
        return respond(200, documents[index])
      }
      return error(405, 'general_route_not_found', `${request.method} is not supported on a document path.`)
    }

    return error(404, 'general_route_not_found', `No route for ${request.path}`)
  }

  return {
    transport,
    requests,
    seed(collection, documents) {
      const bucket = bucketFor(collection)
      for (const document of documents) {
        bucket.push({ $createdAt: new Date().toISOString(), $updatedAt: new Date().toISOString(), ...document })
      }
    },
    documents(collection) {
      return [...bucketFor(collection)]
    },
    openSession(userId, options) {
      const session = randomId(40)
      sessions.set(session, { userId, email: options?.email ?? `${userId.slice(0, 8)}@example.test` })
      return session
    },
    failNext(failure) {
      failures.push({ ...failure })
    },
    setTotalCountHeader(present) {
      totalCountHeader = present
    },
    reset() {
      tables.clear()
      sessions.clear()
      requests.length = 0
      failures.length = 0
      totalCountHeader = true
    },
  }
}
