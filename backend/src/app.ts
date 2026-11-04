// API HTTP de DataMind (Fastify) : jeux de données, profil, graphiques, conversations en flux (SSE).
import { createWriteStream } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'

import { FEATURED, QUICK_ANALYSES, SYSTEM_PROMPT } from './agent/prompts.js'
import { EngineError, listOllamaModels, runClaude, runOllama, type AgentEvent, type HistoryMessage } from './agent/engines.js'
import { runClaudePlan } from './agent/claude-plan.js'
import { TOOL_LABELS } from './agent/tools.js'
import { autoCharts, columnChart } from './charts.js'
import { CLAUDE_MODELS, config as defaultConfig, type Config } from './config.js'
import { DbCache, QueryError, quoteIdent, quoteString, type DatasetDb } from './db.js'
import { ImportError, importFile, SUPPORTED } from './importer.js'
import { computeProfile, profileForPrompt, type Profile } from './profile.js'
import { Store, type Block, type Conversation, type DatasetMeta, type Turn } from './store.js'

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface AppOptions {
  config?: Config
  /** Remplace les moteurs IA (tests). */
  runEngine?: (engine: string, model: string, opts: Parameters<typeof runOllama>[0], apiKey: string) => Promise<{ inputTokens: number; outputTokens: number }>
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? defaultConfig
  const store = new Store(config.dataDir)
  await store.init()
  const dbs = new DbCache(4, config.queryTimeoutMs)
  const profiles = new Map<string, Promise<Profile>>()

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' }, bodyLimit: 2 * 1024 * 1024 })
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } })

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message })
    if (err instanceof ImportError || err instanceof QueryError) return reply.status(400).send({ error: err.message })
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: `Fichier trop volumineux (${config.maxUploadMb} Mo au plus).` })
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message })
    app.log.error(err)
    return reply.status(500).send({ error: 'Erreur interne du serveur.' })
  })

  // ── Accès aux jeux de données ──────────────────────────────────────────────────────────────
  async function dataset(id: string): Promise<DatasetMeta> {
    const meta = await store.getDataset(id).catch(() => null)
    if (!meta) throw new HttpError(404, 'Jeu de données introuvable.')
    return meta
  }
  const db = (id: string): Promise<DatasetDb> => dbs.get(id, store.parquetPath(id))
  function profile(id: string): Promise<Profile> {
    let p = profiles.get(id)
    if (!p) {
      p = db(id).then(computeProfile)
      p.catch(() => profiles.delete(id))
      profiles.set(id, p)
    }
    return p
  }
  function forget(id: string) {
    dbs.drop(id)
    profiles.delete(id)
  }

  // ── Santé et configuration ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', app: 'datamind', version: config.version }))

  app.get('/api/config', async () => {
    let models: string[] = []
    let error: string | null = null
    try {
      models = await listOllamaModels()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const preferred = models.includes(config.ollamaModel) ? config.ollamaModel
      : models.includes(`${config.ollamaModel}:latest`) ? `${config.ollamaModel}:latest` : models[0] ?? config.ollamaModel
    return {
      version: config.version,
      instanceLabel: config.instanceLabel,
      defaultEngine: config.defaultEngine,
      maxUploadMb: config.maxUploadMb,
      formats: SUPPORTED,
      ollama: { reachable: !error, error, models, model: preferred },
      claude: { plan: !!config.claudeOauthToken, serverKey: !!config.anthropicApiKey, model: config.claudeModel, models: CLAUDE_MODELS },
      quickAnalyses: QUICK_ANALYSES,
      featured: FEATURED,
      toolLabels: TOOL_LABELS,
    }
  })

  // ── Jeux de données ───────────────────────────────────────────────────────────────────────
  app.get('/api/datasets', async () => store.listDatasets())

  app.post('/api/datasets', async (req) => {
    const file = await req.file()
    if (!file) throw new HttpError(400, 'Aucun fichier reçu.')
    const tmp = store.tmpPath(file.filename)
    try {
      await pipeline(file.file, createWriteStream(tmp))
      if (file.file.truncated) throw new HttpError(413, `Fichier trop volumineux (${config.maxUploadMb} Mo au plus).`)
      return await importFile(store, tmp, file.filename)
    } finally {
      await rm(tmp, { force: true })
    }
  })

  app.get('/api/samples', async () => {
    const files = ['ventes.csv', 'demo_complet.csv']
    return files.map((f) => ({
      file: f,
      label: f === 'ventes.csv' ? 'Ventes' : 'Clients',
      hint: f === 'ventes.csv' ? '30 commandes · produits, régions' : '400 clients · canaux, dépenses, churn',
    }))
  })

  app.post<{ Params: { file: string } }>('/api/samples/:file', async (req) => {
    const file = req.params.file
    if (!['ventes.csv', 'demo_complet.csv'].includes(file)) throw new HttpError(404, 'Exemple inconnu.')
    const existing = (await store.listDatasets()).find((d) => d.sample && d.fileName === file)
    if (existing) return existing
    return importFile(store, join(config.samplesDir, file), file, { sample: true })
  })

  app.get<{ Params: { id: string } }>('/api/datasets/:id', async (req) => {
    const meta = await dataset(req.params.id)
    const touched = (await store.touchDataset(meta.id)) ?? meta
    return { ...touched, profile: await profile(meta.id) }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/datasets/:id', async (req) => {
    const meta = await dataset(req.params.id)
    const name = String(req.body?.name ?? '').trim().slice(0, 120)
    if (name) {
      meta.name = name
      await store.saveDataset(meta)
    }
    return meta
  })

  app.post<{ Params: { id: string }; Body: { sheet?: string } }>('/api/datasets/:id/sheet', async (req) => {
    const meta = await dataset(req.params.id)
    if (!meta.sheets.includes(String(req.body?.sheet))) throw new HttpError(400, 'Feuille inconnue.')
    forget(meta.id)
    const ext = meta.fileName.slice(meta.fileName.lastIndexOf('.')).toLowerCase()
    const updated = await importFile(store, join(store.datasetDir(meta.id), `source${ext}`), meta.fileName,
      { sheet: req.body.sheet, existingId: meta.id, sample: meta.sample })
    updated.name = meta.name
    await store.saveDataset(updated)
    return updated
  })

  app.delete<{ Params: { id: string } }>('/api/datasets/:id', async (req, reply) => {
    await dataset(req.params.id)
    forget(req.params.id)
    await store.deleteDataset(req.params.id)
    return reply.status(204).send()
  })

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string; q?: string; sort?: string; dir?: string } }>(
    '/api/datasets/:id/rows', async (req) => {
      const meta = await dataset(req.params.id)
      const d = await db(meta.id)
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)))
      const offset = Math.max(0, Number(req.query.offset ?? 0))
      const where = searchClause(meta, String(req.query.q ?? ''))
      const sortCol = meta.columns.find((c) => c.name === req.query.sort)
      const order = sortCol ? `ORDER BY ${quoteIdent(sortCol.name)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : ''
      const total = Number(await d.scalar(`SELECT count(*) FROM data ${where}`))
      const page = await d.query(`SELECT * FROM data ${where} ${order} LIMIT ${limit} OFFSET ${offset}`, limit)
      return { total, offset, limit, columns: page.columns, rows: page.rows }
    })

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/datasets/:id/export.csv', async (req, reply) => {
    const meta = await dataset(req.params.id)
    const d = await db(meta.id)
    const where = searchClause(meta, String(req.query.q ?? ''))
    const r = await d.query(`SELECT * FROM data ${where}`, 2_000_000)
    const cell = (v: unknown) => {
      if (v === null || v === undefined) return ''
      const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v)
      return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
    }
    const lines = [r.columns.map((c) => cell(c.name)).join(';'), ...r.rows.map((row) => row.map(cell).join(';'))]
    const base = meta.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'donnees'
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${base}.csv"`)
      .send('﻿' + lines.join('\r\n'))
  })

  app.get<{ Params: { id: string } }>('/api/datasets/:id/charts', async (req) => {
    const meta = await dataset(req.params.id)
    return autoCharts(await db(meta.id), await profile(meta.id))
  })

  app.get<{ Params: { id: string; name: string } }>('/api/datasets/:id/columns/:name', async (req) => {
    const meta = await dataset(req.params.id)
    const p = await profile(meta.id)
    const col = p.columns.find((c) => c.name === req.params.name)
    if (!col) throw new HttpError(404, 'Colonne inconnue.')
    const d = await db(meta.id)
    const q = quoteIdent(col.name)
    const top = await d.query(`SELECT ${q}::VARCHAR AS valeur, count(*) AS lignes FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, 12)
    return { column: col, chart: await columnChart(d, col), top }
  })

  // ── Conversations ─────────────────────────────────────────────────────────────────────────
  async function conversation(id: string): Promise<Conversation> {
    const c = await store.getConversation(id).catch(() => null)
    if (!c) throw new HttpError(404, 'Conversation introuvable.')
    return c
  }

  app.get<{ Params: { id: string } }>('/api/datasets/:id/conversations', async (req) => {
    await dataset(req.params.id)
    return store.listConversations(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/api/datasets/:id/conversations', async (req) => {
    await dataset(req.params.id)
    return store.createConversation(req.params.id)
  })

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req) => conversation(req.params.id))

  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/conversations/:id', async (req) => {
    const c = await conversation(req.params.id)
    const title = String(req.body?.title ?? '').trim().slice(0, 120)
    if (title) {
      c.title = title
      await store.saveConversation(c)
    }
    return c
  })

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    await store.deleteConversation(req.params.id)
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string }; Body: { text?: string; label?: string; engine?: string; model?: string } }>(
    '/api/conversations/:id/messages', async (req, reply) => {
      const conv = await conversation(req.params.id)
      const meta = await dataset(conv.datasetId)
      const question = String(req.body?.text ?? '').trim()
      if (!question) throw new HttpError(400, 'Message vide.')
      const engine = req.body?.engine === 'claude' ? 'claude' : 'ollama'
      const model = String(req.body?.model ?? (engine === 'claude' ? config.claudeModel : config.ollamaModel))
      const apiKey = config.anthropicApiKey ?? String(req.headers['x-anthropic-key'] ?? '')
      const plan = engine === 'claude' && !!config.claudeOauthToken
      if (engine === 'claude' && !plan && !apiKey) throw new HttpError(400, 'Claude non configuré : forfait (CLAUDE_CODE_OAUTH_TOKEN) ou clé API requis.')

      const [d, p] = await Promise.all([db(meta.id), profile(meta.id)])
      const turn: Turn = {
        id: `turn-${Date.now().toString(36)}`, question, label: req.body?.label ? String(req.body.label) : undefined,
        blocks: [], engine: plan ? 'claude-forfait' : engine, model, createdAt: new Date().toISOString(),
      }
      const history = buildHistory(conv.turns)
      if (!conv.turns.length) conv.title = (turn.label ?? question).slice(0, 80)
      conv.turns.push(turn)

      const controller = new AbortController()
      req.raw.on('close', () => { if (!reply.raw.writableEnded) controller.abort() })
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const send = (event: string, data: unknown) => {
        if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
      send('turn', { id: turn.id, question, label: turn.label, engine, model, title: conv.title })

      const onEvent = (e: AgentEvent) => {
        if (e.type === 'text') turn.blocks.push({ kind: 'text', text: e.text })
        else if (e.type === 'tool_start') turn.blocks.push({ kind: 'tool', id: e.id, name: e.name, input: e.input })
        else {
          const b = turn.blocks.find((x): x is Extract<Block, { kind: 'tool' }> => x.kind === 'tool' && x.id === e.id)
          if (b) b.result = e.result
        }
        send(e.type, e)
      }

      const started = Date.now()
      try {
        const opts = {
          system: `${SYSTEM_PROMPT}\n\n--- DONNÉES ---\n${profileForPrompt(meta.name, p)}`,
          history, question, ctx: { db: d, profile: p }, onEvent, signal: controller.signal,
        }
        const usage = options.runEngine
          ? await options.runEngine(engine, model, opts, apiKey)
          : plan ? await runClaudePlan(opts, model)
            : engine === 'claude' ? await runClaude(opts, apiKey, model) : await runOllama(opts, model)
        turn.usage = usage
        turn.durationMs = Date.now() - started
        send('done', { usage, durationMs: turn.durationMs })
      } catch (err) {
        const aborted = controller.signal.aborted
        turn.error = aborted ? 'Analyse arrêtée.' : err instanceof EngineError ? err.message : `Erreur : ${err instanceof Error ? err.message : String(err)}`
        if (!aborted && !(err instanceof EngineError)) app.log.error(err)
        send('error', { message: turn.error })
      } finally {
        clearInterval(ping)
        await store.saveConversation(conv).catch((e) => app.log.error(e))
        await store.touchDataset(meta.id).catch(() => null)
        reply.raw.end()
      }
    })

  // ── Interface compilée ────────────────────────────────────────────────────────────────────
  if (config.staticDir) {
    const index = await readFile(join(config.staticDir, 'index.html'), 'utf8').catch(() => null)
    await app.register(fastifyStatic, { root: config.staticDir, wildcard: false, index: false })
    app.get('/', (_req, reply) => sendIndex(reply, index))
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Route inconnue.' })
      if (req.method === 'GET') {
        const path = join(config.staticDir!, decodeURIComponent(req.url.split('?')[0]))
        return stat(path).then((s) => (s.isFile() ? reply.sendFile(path.slice(config.staticDir!.length + 1)) : sendIndex(reply, index)))
          .catch(() => sendIndex(reply, index))
      }
      return reply.status(404).send({ error: 'Route inconnue.' })
    })
  }
  return app
}

/** Filtre « contient » sur toutes les colonnes (texte), insensible à la casse. */
function searchClause(meta: DatasetMeta, q: string): string {
  const term = q.trim()
  if (!term) return ''
  const cols = meta.columns.map((c) => `coalesce(${quoteIdent(c.name)}::VARCHAR, '')`).join(", ' ', ")
  return `WHERE concat(${cols}) ILIKE ${quoteString(`%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)} ESCAPE '\\'`
}

function sendIndex(reply: FastifyReply, index: string | null) {
  if (!index) return reply.status(404).send('Interface non compilée.')
  return reply.header('cache-control', 'no-cache').type('text/html').send(index)
}

/** Historique compact des tours précédents, indépendant du moteur. */
function buildHistory(turns: Turn[]): HistoryMessage[] {
  const out: HistoryMessage[] = []
  for (const t of turns.slice(-6)) {
    if (t.error && !t.blocks.length) continue
    const parts: string[] = []
    for (const b of t.blocks) {
      if (b.kind === 'text') parts.push(b.text)
      else if (b.result) parts.push(`[${b.name}${b.result.sql ? ` : ${b.result.sql}` : ''}] ${b.result.summary.slice(0, 600)}`)
    }
    const answer = parts.join('\n\n').slice(-4000)
    if (!answer) continue
    out.push({ role: 'user', content: t.question }, { role: 'assistant', content: answer })
  }
  return out
}
