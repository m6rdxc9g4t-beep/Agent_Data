// Réglages lus dans l'environnement (toutes les variables sont facultatives).
import { resolve } from 'node:path'

const env = process.env

function first(...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim()
    if (v) return v
  }
  return undefined
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(env[name] ?? '', 10)
  return Number.isFinite(v) ? v : fallback
}

export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — équilibré' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — le plus précis' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — le plus rapide' },
]

export const config = {
  version: '6.4.0',
  host: env.HOST ?? '127.0.0.1',
  port: int('PORT', 3600),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : undefined,
  samplesDir: resolve(env.SAMPLES_DIR ?? new URL('../../sample_data', import.meta.url).pathname),
  maxUploadMb: int('MAX_UPLOAD_MB', 200),

  ollamaUrl: (first('OLLAMA_URL', 'OLLAMA_BASE_URL', 'OLLAMA_HOST') ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: first('OLLAMA_MODEL') ?? 'llama3.1',
  ollamaTimeoutMs: int('OLLAMA_TIMEOUT', 600) * 1000,
  ollamaNumCtx: int('OLLAMA_NUM_CTX', 8192),

  anthropicApiKey: first('ANTHROPIC_API_KEY'),
  // Forfait Claude (Pro / Max) sans clé API : jeton de `claude setup-token`, usage personnel.
  claudeOauthToken: first('CLAUDE_CODE_OAUTH_TOKEN', 'DATAMIND_CLAUDE_OAUTH_TOKEN'),
  claudeModel: first('DATAMIND_CLAUDE_MODEL') ?? CLAUDE_MODELS[0].id,

  maxSteps: int('DATAMIND_MAX_STEPS', 12),
  queryTimeoutMs: int('DATAMIND_QUERY_TIMEOUT', 60) * 1000,
  instanceLabel: first('DATAMIND_INSTANCE_LABEL') ?? '',

  // Moteur proposé par défaut : Claude si le forfait est configuré, sinon Ollama.
  defaultEngine: (first('DATAMIND_ENGINE') ?? (first('CLAUDE_CODE_OAUTH_TOKEN', 'DATAMIND_CLAUDE_OAUTH_TOKEN') ? 'claude' : 'ollama')) as 'ollama' | 'claude',
}

export type Config = typeof config
