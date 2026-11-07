// Moteurs IA : boucle agentique Claude (API Anthropic) et Ollama (local).
// Les deux exécutent les outils et émettent le déroulé au fil de l'eau (texte, début et fin d'outil).
import Anthropic from '@anthropic-ai/sdk'

import { config } from '../config.js'
import type { ToolOutput } from '../store.js'
import { runTool, TOOLS, type ToolContext } from './tools.js'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; result: ToolOutput }

export interface HistoryMessage { role: 'user' | 'assistant'; content: string }

export interface RunOptions {
  system: string
  history: HistoryMessage[]
  question: string
  ctx: ToolContext
  onEvent: (e: AgentEvent) => void
  signal?: AbortSignal
  maxSteps?: number
  /** Délai d'un appel au modèle (Ollama ; défaut : OLLAMA_TIMEOUT). */
  callTimeoutMs?: number
  /** Jetons produits au plus par appel (Ollama : `num_predict`). */
  maxOutputTokens?: number
}

export interface Usage { inputTokens: number; outputTokens: number }

export class EngineError extends Error {}

export const STEP_LIMIT = "Analyse interrompue : nombre maximal d'étapes atteint. Précisez la demande ou relancez pour continuer."

let seq = 0
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`

async function execTool(name: string, input: Record<string, unknown>, opts: RunOptions, id = newId()): Promise<ToolOutput> {
  opts.onEvent({ type: 'tool_start', id, name, input })
  const result = await runTool(name, input, opts.ctx)
  opts.onEvent({ type: 'tool_end', id, result })
  return result
}

// --------------------------------------------------------------------------------------------- //
// Claude
// --------------------------------------------------------------------------------------------- //
export async function runClaude(opts: RunOptions, apiKey: string, model: string): Promise<Usage> {
  if (!apiKey) throw new EngineError('Clé API Anthropic manquante.')
  const client = new Anthropic({ apiKey, maxRetries: 3 })
  const tools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t))
  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: opts.question },
  ]
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let thinking = true

  const create = async () => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      tools: tools as Anthropic.Tool[],
      messages,
    }
    if (thinking) (params as unknown as Record<string, unknown>).thinking = { type: 'adaptive' }
    try {
      return await client.messages.create(params, { signal: opts.signal })
    } catch (err) {
      if (thinking && err instanceof Anthropic.BadRequestError && /thinking/i.test(err.message)) {
        thinking = false
        return client.messages.create({ ...params, thinking: undefined } as Anthropic.MessageCreateParamsNonStreaming, { signal: opts.signal })
      }
      throw err
    }
  }

  try {
    for (let step = 0; step < (opts.maxSteps ?? config.maxSteps); step++) {
      const res = await create()
      const u = res.usage as unknown as Record<string, number | null>
      usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      usage.outputTokens += u.output_tokens ?? 0
      messages.push({ role: 'assistant', content: res.content })

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type === 'text' && block.text.trim()) opts.onEvent({ type: 'text', text: block.text })
      }
      if (res.stop_reason !== 'tool_use') return usage
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue
        const out = await execTool(block.name, (block.input ?? {}) as Record<string, unknown>, opts, block.id)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.summary, is_error: !out.ok })
      }
      messages.push({ role: 'user', content: results })
    }
    opts.onEvent({ type: 'text', text: STEP_LIMIT })
    return usage
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new EngineError('Clé API Anthropic refusée : vérifiez-la.')
    if (err instanceof Anthropic.NotFoundError) throw new EngineError(`Modèle « ${model} » introuvable pour cette clé.`)
    if (err instanceof Anthropic.RateLimitError) throw new EngineError("Limite de débit de l'API atteinte : réessayez dans un instant.")
    if (err instanceof Anthropic.APIConnectionError && !opts.signal?.aborted) throw new EngineError('API Anthropic injoignable.')
    throw err
  }
}

// --------------------------------------------------------------------------------------------- //
// Ollama
// --------------------------------------------------------------------------------------------- //
interface OllamaMessage {
  role: string
  content: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[]
  tool_name?: string
}

const toolNames = new Set(TOOLS.map((t) => t.name))

/** Appel d'outil écrit en JSON dans le texte (travers fréquent des petits modèles). */
export function extractJsonToolCall(content: string): { name: string; input: Record<string, unknown> } | null {
  let text = (content ?? '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/)
  if (fenced) text = fenced[1].trim()
  if (!text.startsWith('{') || !text.includes('"name"')) return null
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || !toolNames.has(obj.name)) return null
    let args = obj.parameters ?? obj.arguments ?? {}
    if (typeof args === 'string') args = JSON.parse(args)
    return { name: obj.name, input: args }
  } catch {
    return null
  }
}

/** Requête proposée dans un bloc ```sql``` sans appel d'outil. */
export function extractSqlBlock(content: string): string | null {
  const m = (content ?? '').match(/```sql\s*\n([\s\S]*?)```/i)
  return m ? m[1].trim() : null
}

export async function listOllamaModels(timeoutMs = 4000): Promise<string[]> {
  const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { models?: { name?: string; model?: string }[] }
  return (data.models ?? []).map((m) => m.model ?? m.name ?? '').filter(Boolean).sort()
}

export async function runOllama(opts: RunOptions, model: string): Promise<Usage> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.history,
    { role: 'user', content: opts.question },
  ]
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let lastSql: string | null = null

  for (let step = 0; step < (opts.maxSteps ?? config.maxSteps); step++) {
    let res: Response
    try {
      const signals = [AbortSignal.timeout(opts.callTimeoutMs ?? config.ollamaTimeoutMs), ...(opts.signal ? [opts.signal] : [])]
      res = await fetch(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages, tools, stream: false,
          options: { num_ctx: config.ollamaNumCtx, temperature: 0.2, ...(opts.maxOutputTokens ? { num_predict: opts.maxOutputTokens } : {}) },
        }),
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      if (opts.signal?.aborted) throw err
      if (err instanceof Error && err.name === 'TimeoutError') throw new EngineError("Ollama n'a pas répondu à temps.")
      throw new EngineError(`Impossible de joindre Ollama (${config.ollamaUrl}). Est-il démarré ?`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (/not found/i.test(body)) throw new EngineError(`Modèle « ${model} » absent du serveur Ollama : ollama pull ${model}`)
      if (/does not support tools/i.test(body)) {
        throw new EngineError(`Le modèle « ${model} » ne gère pas les outils. Choisissez llama3.1, llama3.2, qwen2.5 ou mistral-nemo.`)
      }
      throw new EngineError(`Ollama a répondu ${res.status} : ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { message: OllamaMessage; prompt_eval_count?: number; eval_count?: number }
    usage.inputTokens += data.prompt_eval_count ?? 0
    usage.outputTokens += data.eval_count ?? 0
    const msg = data.message ?? { role: 'assistant', content: '' }
    const content = msg.content ?? ''
    messages.push({ role: 'assistant', content, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) })

    if (msg.tool_calls?.length) {
      if (content.trim()) opts.onEvent({ type: 'text', text: content })
      for (const call of msg.tool_calls) {
        let args = call.function?.arguments ?? {}
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = {} }
        }
        const out = await execTool(call.function?.name ?? '', args as Record<string, unknown>, opts)
        messages.push({ role: 'tool', content: out.summary, tool_name: call.function?.name })
      }
      continue
    }

    // Repli 1 : appel d'outil écrit en JSON dans le texte.
    const jsonCall = extractJsonToolCall(content)
    if (jsonCall) {
      const out = await execTool(jsonCall.name, jsonCall.input, opts)
      messages.push({ role: 'tool', content: out.summary, tool_name: jsonCall.name })
      continue
    }

    if (content.trim()) opts.onEvent({ type: 'text', text: content })

    // Repli 2 : requête proposée dans un bloc ```sql``` sans appel d'outil.
    const sql = extractSqlBlock(content)
    if (sql && sql !== lastSql) {
      lastSql = sql
      const out = await execTool('run_sql', { sql }, opts)
      messages.push({
        role: 'user',
        content: `Résultat réel de ta requête :\n${out.summary}\n\n` +
          (out.ok ? 'Interprète ces résultats pour répondre à la question, sans inventer de chiffres.' : "Corrige la requête et relance-la avec l'outil run_sql."),
      })
      continue
    }
    return usage
  }
  opts.onEvent({ type: 'text', text: STEP_LIMIT })
  return usage
}
