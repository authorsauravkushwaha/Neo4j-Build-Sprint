/**
 * AI provider adapter.
 *
 * Design constraints (from the brief and from operational reality):
 *  - AI is optional. `provider: 'none'` is a first-class configuration and the
 *    app is fully functional in that mode.
 *  - The provider is replaceable: two wire formats are supported today
 *    (`gemini`, `openai-compatible`), and adding another means implementing one
 *    interface.
 *  - Hard timeout, bounded output, at most one retry on a retryable status.
 *    There is no unbounded retry loop and no streaming (a free tier plus a
 *    mobile client does not need either).
 *  - Keys live only in Edge Function secrets. This module is server-only and
 *    never logs the key, the prompt or the raw response body.
 */
import { AppError } from './errors.ts'
import { redactSecretsInString } from './security.ts'

export type AiProviderName = 'none' | 'gemini' | 'openai-compatible'

export interface AiConfig {
  provider: AiProviderName
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs: number
  maxOutputTokens: number
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  onEvent?: (event: { type: 'call' | 'error' | 'skip'; provider: AiProviderName; ms?: number; status?: number }) => void
}

export interface AiCompletion {
  text: string
  providerName: string
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface AiProvider {
  readonly name: AiProviderName
  readonly configured: boolean
  readonly model: string
  complete(prompt: { system: string; user: string; maxOutputTokens?: number }): Promise<AiCompletion>
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Extracts text from a Gemini generateContent response. */
export function extractGeminiText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as Record<string, unknown>
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const first = candidates[0] as Record<string, unknown> | undefined
  if (!first) return null
  if (typeof first.finishReason === 'string' && /SAFETY|RECITATION|BLOCK/i.test(first.finishReason)) return ''
  const content = first.content as Record<string, unknown> | undefined
  const parts = Array.isArray(content?.parts) ? (content?.parts as Array<Record<string, unknown>>) : []
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
  return text.length > 0 ? text : null
}

/** Extracts text from an OpenAI-compatible chat completion. */
export function extractOpenAiText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as Record<string, unknown>
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first) return null
  const message = first.message as Record<string, unknown> | undefined
  if (message && typeof message.content === 'string' && message.content.trim().length > 0) {
    return message.content.trim()
  }
  if (typeof first.text === 'string' && first.text.trim().length > 0) return first.text.trim()
  return null
}

export function createAiProvider(config: AiConfig): AiProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = Math.max(2000, Math.min(config.timeoutMs, 60_000))
  const maxOutputTokens = Math.max(64, Math.min(config.maxOutputTokens, 4096))
  const configured = config.provider !== 'none' && config.apiKey.trim().length > 0

  const name: AiProviderName = configured ? config.provider : 'none'

  const callWithRetry = async (
    url: string,
    init: RequestInit,
    extract: (payload: unknown) => string | null,
  ): Promise<AiCompletion> => {
    const started = Date.now()
    let lastError: AppError | null = null

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal })
        if (!response.ok) {
          await response.text().catch(() => '')
          if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            continue
          }
          const code = response.status === 429 ? 'rate_limited' : 'dependency_unavailable'
          config.onEvent?.({ type: 'error', provider: name, status: response.status })
          throw new AppError(code, {
            internal: `ai provider http ${response.status}`,
            retryAfterSeconds: response.status === 429 ? 10 : undefined,
          })
        }
        const payload = await response.json().catch(() => null)
        const text = extract(payload)
        if (text === null) {
          config.onEvent?.({ type: 'error', provider: name, status: 200 })
          throw new AppError('dependency_unavailable', { internal: 'ai provider returned no usable text' })
        }
        config.onEvent?.({ type: 'call', provider: name, ms: Date.now() - started, status: 200 })
        return {
          text,
          providerName: `${name}:${config.model}`,
          model: config.model,
          usage: undefined,
        }
      } catch (error) {
        if (error instanceof AppError) {
          lastError = error
          if (error.code === 'dependency_unavailable' && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            continue
          }
          throw error
        }
        const isAbort = error instanceof Error && error.name === 'AbortError'
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          continue
        }
        lastError = new AppError(isAbort ? 'timeout' : 'dependency_unavailable', {
          internal: isAbort ? 'ai timeout' : redactSecretsInString(String(error)),
        })
        throw lastError
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new AppError('dependency_unavailable', { internal: 'ai adapter exhausted retries' })
  }

  if (!configured) {
    return {
      name: 'none',
      configured: false,
      model: config.model,
      complete: async () => {
        config.onEvent?.({ type: 'skip', provider: 'none' })
        throw new AppError('not_configured', {
          publicMessage: 'No AI provider is configured on this deployment, so the rules engine answered instead.',
        })
      },
    }
  }

  if (config.provider === 'gemini') {
    const model = config.model || 'gemini-2.0-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    return {
      name: 'gemini',
      configured: true,
      model,
      complete: async ({ system, user, maxOutputTokens: override }) =>
        callWithRetry(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // Key in a header, never in the URL: URLs leak into logs and proxies.
              'x-goog-api-key': config.apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: {
                temperature: 0.4,
                maxOutputTokens: Math.min(override ?? maxOutputTokens, maxOutputTokens),
                responseMimeType: 'application/json',
              },
            }),
          },
          extractGeminiText,
        ),
    }
  }

  const baseUrl = (config.baseUrl ?? '').replace(/\/$/, '')
  if (!baseUrl) {
    return {
      name: 'none',
      configured: false,
      model: config.model,
      complete: async () => {
        throw new AppError('not_configured', {
          publicMessage: 'The OpenAI-compatible provider is missing a base URL, so the rules engine answered instead.',
        })
      },
    }
  }

  return {
    name: 'openai-compatible',
    configured: true,
    model: config.model,
    complete: async ({ system, user, maxOutputTokens: override }) =>
      callWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.4,
            max_tokens: Math.min(override ?? maxOutputTokens, maxOutputTokens),
          }),
        },
        extractOpenAiText,
      ),
  }
}

export function describeProvider(config: Pick<AiConfig, 'provider' | 'apiKey' | 'model' | 'baseUrl'>): string {
  if (config.provider === 'none' || !config.apiKey) return 'none (rules engine only)'
  if (config.provider === 'gemini') return `gemini (${config.model || 'default model'})`
  return `openai-compatible (${config.model || 'default model'})`
}

/** Parses the JSON envelope we ask models for, tolerating prose wrappers. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const direct = safeJson(trimmed)
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>

  // Some free-tier models wrap JSON in a code fence or add a sentence.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]{0,6000}?)\s*```/i)
  if (fenced) {
    const parsed = safeJson(fenced[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = safeJson(trimmed.slice(firstBrace, lastBrace + 1))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  return null
}


