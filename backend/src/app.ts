// API HTTP de DataMind (Fastify) : jeux de données, profil, graphiques, conversations en flux (SSE).
import { randomUUID } from 'node:crypto'
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
import { applyCleaning, planCleaning, type CleanStep } from './clean.js'
import { autoCharts, columnChart } from './charts.js'
import { CLAUDE_MODELS, config as defaultConfig, type Config } from './config.js'
import { DatasetDb, DbCache, QueryError, quoteIdent, quoteString, type ExtraTable } from './db.js'
import {
  clientIp, DEMO_BUSY, DEMO_CLAUDE_OFF, DEMO_COMPUTE, DEMO_LIMITS, DEMO_READ_BLOCKED, DEMO_REFUSED, DEMO_TIMEOUT, DEMO_WRITE_ALLOWED,
  DemoBusyError, DemoSessions, HourlyLimit, SingleSlot, type DemoSession,
} from './demo.js'
import { ImportError, importFile, SUPPORTED } from './importer.js'
import { featureCandidates, targetCandidates } from './ml/prepare.js'
import { forecastSeries } from './ml/timeseries.js'
import { ModelStore, scoreRows } from './ml/models.js'
import { predictOne, recentModel, trainModels, type ModelKind } from './ml/train.js'
import { computeProfile, profileForPrompt, type Profile } from './profile.js'
import { Store, type Block, type Conversation, type DatasetLink, type DatasetMeta, type Pin, type Turn } from './store.js'

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

/** En démo publique, Claude est coupé quelle que soit la configuration (jeton du forfait et clé API ignorés). */
function demoSafe(config: Config): Config {
  return config.demo ? { ...config, claudeOauthToken: undefined, anthropicApiKey: undefined, defaultEngine: 'ollama' } : config
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = demoSafe(options.config ?? defaultConfig)
  const demo = config.demo
  const store = new Store(config.dataDir)
  await store.init()
  const dbs = new DbCache(4, demo ? Math.min(config.queryTimeoutMs, DEMO_LIMITS.queryTimeoutMs) : config.queryTimeoutMs)
  const profiles = new Map<string, Promise<Profile>>()
  const models = new ModelStore(config.dataDir)

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

  // ── Démo publique : liste blanche des routes, sessions éphémères, limites de l'IA ─────────────
  const sessions = new DemoSessions()
  const questionLimit = new HourlyLimit(config.demoQuestionsPerHour)
  const computeLimit = new HourlyLimit(DEMO_LIMITS.computePerHour)
  const slot = new SingleSlot(DEMO_LIMITS.queueSize, DEMO_LIMITS.queueWaitMs)
  /** Refus explicite dans les routes d'écriture (en plus de la liste blanche ci-dessous). */
  const noDemo = () => { if (demo) throw new HttpError(403, DEMO_REFUSED) }
  if (demo) {
    // Avant toute lecture du corps : une écriture hors liste blanche est refusée, quel que soit son contenu.
    app.addHook('onRequest', async (req, reply) => {
      const route = req.routeOptions.url
      if (!route?.startsWith('/api/')) return
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const key = `${method} ${route}`
      if (method === 'GET' ? DEMO_READ_BLOCKED.has(key) : !DEMO_WRITE_ALLOWED.has(key)) {
        return reply.status(403).send({ error: DEMO_REFUSED })
      }
      if (DEMO_COMPUTE.has(key)) {
        const ip = clientIp(req)
        const wait = computeLimit.waitMinutes(ip)
        if (wait) return reply.status(429).send({ error: `Limite de la démo atteinte pour les calculs : nouvel essai possible dans ${wait} min.` })
        computeLimit.take(ip)
      }
    })
  }
  /** Analyse de la session du visiteur (démo). */
  function demoConversation(session: DemoSession | null, id: string): Conversation {
    const c = session?.conversations.get(id)
    if (!c) throw new HttpError(404, 'Conversation introuvable.')
    return c
  }

  // ── Accès aux jeux de données ──────────────────────────────────────────────────────────────
  async function dataset(id: string): Promise<DatasetMeta> {
    const meta = await store.getDataset(id).catch(() => null)
    // Démo : seuls les jeux d'exemple d'origine existent (jamais un fichier importé ni une version nettoyée).
    if (!meta || (demo && (!meta.sample || meta.cleanedFrom))) throw new HttpError(404, 'Jeu de données introuvable.')
    return meta
  }
  /** Fichiers liés encore présents, avec leur métadonnée. */
  async function linked(meta: DatasetMeta): Promise<{ link: DatasetLink; meta: DatasetMeta }[]> {
    const out: { link: DatasetLink; meta: DatasetMeta }[] = []
    if (demo) return out // pas de fichiers liés dans la démo
    for (const link of meta.links ?? []) {
      const other = await store.getDataset(link.id).catch(() => null)
      if (other) out.push({ link, meta: other })
    }
    return out
  }
  async function db(id: string): Promise<DatasetDb> {
    const meta = await store.getDataset(id).catch(() => null)
    const extra: ExtraTable[] = meta ? (await linked(meta)).map((l) => ({ table: l.link.table, path: store.parquetPath(l.meta.id) })) : []
    return dbs.get(id, store.parquetPath(id), extra)
  }
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

  /** Modèles du serveur Ollama et modèle préféré (OLLAMA_MODEL s'il est installé). */
  async function ollamaModels(): Promise<{ models: string[]; error: string | null; preferred: string }> {
    let models: string[] = []
    let error: string | null = null
    try {
      models = await listOllamaModels()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const preferred = models.includes(config.ollamaModel) ? config.ollamaModel
      : models.includes(`${config.ollamaModel}:latest`) ? `${config.ollamaModel}:latest` : models[0] ?? config.ollamaModel
    return { models, error, preferred }
  }
  // Démo : le modèle est celui du serveur, jamais choisi par le visiteur (relu au plus toutes les minutes).
  let demoModel: { at: number; name: string } | null = null
  async function serverModel(): Promise<string> {
    if (!demoModel || Date.now() - demoModel.at > 60_000) demoModel = { at: Date.now(), name: (await ollamaModels()).preferred }
    return demoModel.name
  }

  app.get('/api/config', async () => {
    const { models, error, preferred } = await ollamaModels()
    return {
      version: config.version,
      instanceLabel: config.instanceLabel,
      defaultEngine: config.defaultEngine,
      maxUploadMb: demo ? 0 : config.maxUploadMb,
      formats: demo ? [] : SUPPORTED,
      ollama: { reachable: !error, error, models: demo ? (error ? [] : [preferred]) : models, model: preferred },
      claude: demo
        ? { plan: false, serverKey: false, model: config.claudeModel, models: [] }
        : { plan: !!config.claudeOauthToken, serverKey: !!config.anthropicApiKey, model: config.claudeModel, models: CLAUDE_MODELS },
      demo: demo ? { questionsPerHour: config.demoQuestionsPerHour, returnUrl: config.demoReturnUrl || null } : null,
      quickAnalyses: QUICK_ANALYSES,
      featured: FEATURED,
      toolLabels: TOOL_LABELS,
    }
  })

  // ── Jeux de données ───────────────────────────────────────────────────────────────────────
  app.get('/api/datasets', async (req) => {
    if (!demo) return store.listDatasets()
    // Démo : les jeux d'exemple ouverts par ce visiteur, le plus récent en tête.
    const session = sessions.find(req)
    if (!session) return []
    const opened = [...session.opened].sort((a, b) => b[1] - a[1])
    const metas = await Promise.all(opened.map(async ([id, at]) => {
      const meta = await store.getDataset(id).catch(() => null)
      return meta?.sample ? { ...meta, lastActivityAt: new Date(at).toISOString() } : null
    }))
    return metas.filter((m) => !!m)
  })

  app.post('/api/datasets', async (req) => {
    noDemo()
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

  // Jeux d'exemple : catalogue sample_data/catalog.json (titre, domaine, description, idées d'analyse).
  interface SampleEntry { file: string; label: string; domain: string; rows: number; columns: number; description: string; ideas: string[] }
  const catalog: SampleEntry[] = JSON.parse(await readFile(join(config.samplesDir, 'catalog.json'), 'utf8').catch(() => '[]'))

  // Démo : tous les jeux d'exemple sont chargés au démarrage (par le serveur, depuis sample_data/ seulement) ;
  // ensuite, plus aucune écriture sur le disque.
  if (demo) {
    const present = new Set((await store.listDatasets()).filter((d) => d.sample && !d.cleanedFrom).map((d) => d.fileName))
    for (const entry of catalog) {
      if (present.has(entry.file)) continue
      const meta = await importFile(store, join(config.samplesDir, entry.file), entry.file, { sample: true })
      meta.name = entry.label
      await store.saveDataset(meta)
    }
  }
  const sampleMeta = async (file: string) =>
    (await store.listDatasets()).find((d) => d.sample && !d.cleanedFrom && d.fileName === file)

  app.get('/api/samples', async (req) => {
    const loaded = new Map((await store.listDatasets()).filter((d) => d.sample).map((d) => [d.fileName, d.id]))
    const opened = demo ? sessions.find(req)?.opened : undefined
    return catalog.map((c) => {
      const id = loaded.get(c.file) ?? null
      return { ...c, datasetId: demo ? (id && opened?.has(id) ? id : null) : id }
    })
  })

  app.post<{ Params: { file: string } }>('/api/samples/:file', async (req, reply) => {
    const entry = catalog.find((c) => c.file === req.params.file)
    if (!entry) throw new HttpError(404, 'Exemple inconnu.')
    const existing = await sampleMeta(entry.file)
    if (demo) {
      // Rien n'est importé : l'exemple a été chargé au démarrage, il rejoint la liste de ce visiteur.
      if (!existing) throw new HttpError(404, 'Exemple indisponible.')
      sessions.get(req, reply).opened.set(existing.id, Date.now())
      return existing
    }
    if (existing) return existing
    const meta = await importFile(store, join(config.samplesDir, entry.file), entry.file, { sample: true })
    meta.name = entry.label
    await store.saveDataset(meta)
    return meta
  })

  app.get<{ Params: { id: string } }>('/api/datasets/:id', async (req) => {
    const meta = await dataset(req.params.id)
    const touched = demo ? meta : (await store.touchDataset(meta.id)) ?? meta
    return { ...touched, profile: await profile(meta.id) }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; descriptions?: Record<string, string>; context?: string } }>('/api/datasets/:id', async (req) => {
    noDemo()
    const meta = await dataset(req.params.id)
    const b = req.body ?? {}
    const name = String(b.name ?? '').trim().slice(0, 120)
    if (name) meta.name = name
    if (b.descriptions && typeof b.descriptions === 'object') {
      const known = new Set(meta.columns.map((c) => c.name))
      meta.descriptions = Object.fromEntries(Object.entries({ ...meta.descriptions, ...b.descriptions })
        .filter(([k, v]) => known.has(k) && String(v ?? '').trim()).map(([k, v]) => [k, String(v).trim().slice(0, 300)]))
    }
    if (typeof b.context === 'string') meta.context = b.context.trim().slice(0, 2000) || undefined
    await store.saveDataset(meta)
    return meta
  })

  // Requête SQL relancée ou modifiée par l'utilisateur depuis une étape de l'agent (lecture seule).
  app.post<{ Params: { id: string }; Body: { sql?: string } }>('/api/datasets/:id/query', async (req) => {
    const meta = await dataset(req.params.id)
    const sql = String(req.body?.sql ?? '')
    if (sql.length > 20_000) throw new HttpError(400, 'Requête trop longue.')
    const started = Date.now()
    const r = await (await db(meta.id)).safeQuery(sql, 500)
    return { ...r, durationMs: Date.now() - started }
  })

  app.post<{ Params: { id: string }; Body: { sheet?: string } }>('/api/datasets/:id/sheet', async (req) => {
    noDemo()
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
    noDemo()
    await dataset(req.params.id)
    forget(req.params.id)
    await store.deleteDataset(req.params.id)
    for (const other of await store.listDatasets()) {
      if (other.links?.some((l) => l.id === req.params.id)) {
        other.links = other.links.filter((l) => l.id !== req.params.id)
        await store.saveDataset(other)
        forget(other.id)
      }
    }
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
    const lines = [r.columns.map((c) => csvCell(c.name)).join(';'), ...r.rows.map((row) => row.map(csvCell).join(';'))]
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

  // ── Nettoyage appliqué (crée une nouvelle version, l'original est conservé) ─────────────────
  app.get<{ Params: { id: string } }>('/api/datasets/:id/clean/plan', async (req) => {
    const meta = await dataset(req.params.id)
    const [d, p] = await Promise.all([db(meta.id), profile(meta.id)])
    return planCleaning(d, p)
  })

  app.post<{ Params: { id: string }; Body: { steps?: CleanStep[] } }>('/api/datasets/:id/clean', async (req) => {
    noDemo()
    const meta = await dataset(req.params.id)
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : []
    try {
      return await applyCleaning(store, meta, await profile(meta.id), steps)
    } catch (err) {
      if (err instanceof ImportError) throw err
      throw new HttpError(400, err instanceof Error ? err.message : String(err))
    }
  })

  // ── Fichiers liés (jointures) ─────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/datasets/:id/links', async (req) => {
    const meta = await dataset(req.params.id)
    return (await linked(meta)).map(({ link, meta: m }) => ({
      ...link, name: m.name, rows: m.rows, columns: m.columns, keys: commonColumns(meta, m),
    }))
  })

  app.get<{ Params: { id: string }; Querystring: { other?: string } }>('/api/datasets/:id/links/suggest', async (req) => {
    const meta = await dataset(req.params.id)
    const other = await dataset(String(req.query.other ?? ''))
    if (other.id === meta.id) throw new HttpError(400, 'Choisissez un autre jeu de données.')
    const keys = commonColumns(meta, other).slice(0, 6)
    const result = { table: tableName(other.name, meta.links ?? []), keys: [] as KeyCheck[] }
    if (!keys.length) return result
    const tmp = await DatasetDb.open(store.parquetPath(meta.id), config.queryTimeoutMs, [{ table: 'autre', path: store.parquetPath(other.id) }])
    try {
      for (const k of keys) {
        const a = quoteIdent(k.column), b = quoteIdent(k.other)
        const r = await tmp.query(`SELECT
            (SELECT avg((${a}::VARCHAR IN (SELECT ${b}::VARCHAR FROM autre))::INT) FROM data WHERE ${a} IS NOT NULL),
            (SELECT count(DISTINCT ${b}) = count(${b}) FROM autre),
            (SELECT count(DISTINCT ${a}) FROM data)`, 1)
        const [share, unique, distinct] = r.rows[0]
        result.keys.push({ column: k.column, other: k.other, matchShare: Number(share ?? 0), uniqueInOther: !!unique, distinct: Number(distinct ?? 0) })
      }
    } finally {
      tmp.close()
    }
    result.keys.sort((x, y) => Number(y.uniqueInOther) - Number(x.uniqueInOther) || y.matchShare - x.matchShare)
    return result
  })

  app.put<{ Params: { id: string }; Body: { links?: DatasetLink[] } }>('/api/datasets/:id/links', async (req) => {
    noDemo()
    const meta = await dataset(req.params.id)
    const links = Array.isArray(req.body?.links) ? req.body.links : []
    if (links.length > 5) throw new HttpError(400, 'Cinq fichiers liés au plus.')
    const seen = new Set<string>()
    const clean: DatasetLink[] = []
    for (const l of links) {
      const table = String(l.table ?? '').trim().toLowerCase()
      if (!/^[a-z_][a-z0-9_]{0,39}$/.test(table) || table === 'data') throw new HttpError(400, `Nom de table invalide : « ${table} » (lettres, chiffres et _, autre que data).`)
      if (seen.has(table)) throw new HttpError(400, `Nom de table en double : « ${table} ».`)
      if (l.id === meta.id) throw new HttpError(400, 'Un jeu ne peut pas être lié à lui-même.')
      await dataset(String(l.id))
      seen.add(table)
      clean.push({ id: String(l.id), table })
    }
    meta.links = clean
    await store.saveDataset(meta)
    forget(meta.id)
    return meta
  })

  // ── Prédiction (apprentissage automatique) ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/datasets/:id/ml/options', async (req) => {
    const meta = await dataset(req.params.id)
    const p = await profile(meta.id)
    const targets = targetCandidates(p).map((c) => ({
      name: c.name, kind: c.kind,
      task: c.kind === 'numeric' ? 'regression' : c.distinct === 2 ? 'binary' : 'multiclass',
    }))
    const features = p.columns.map((c) => ({ name: c.name, kind: c.kind, usable: featureCandidates(p, '').some((f) => f.name === c.name) }))
    return {
      targets,
      features,
      dates: p.columns.filter((c) => c.kind === 'datetime').map((c) => c.name),
      values: p.columns.filter((c) => c.kind === 'numeric' || c.kind === 'boolean').map((c) => c.name),
    }
  })

  app.post<{ Params: { id: string }; Body: { target?: string; features?: string[]; models?: ModelKind[] } }>(
    '/api/datasets/:id/ml/train', async (req) => {
      const meta = await dataset(req.params.id)
      const target = String(req.body?.target ?? '')
      if (!target) throw new HttpError(400, 'Choisissez la variable à prédire.')
      const [d, p] = await Promise.all([db(meta.id), profile(meta.id)])
      return trainModels(d, p, target, Array.isArray(req.body?.features) ? req.body.features.map(String) : undefined, req.body?.models)
    })

  async function model(id: string) {
    // Démo : seulement les modèles entraînés en mémoire, jamais ceux enregistrés sur le disque.
    const m = demo ? recentModel(id) ?? null : await models.get(id).catch(() => null)
    if (!m) throw new HttpError(404, 'Modèle introuvable : il n’a pas été enregistré avant le redémarrage du serveur. Relancez l’entraînement.')
    return m
  }

  app.post<{ Params: { id: string }; Body: { values?: Record<string, unknown> } }>('/api/ml/models/:id/predict', async (req) =>
    predictOne(await model(req.params.id), req.body?.values ?? {}))

  // Modèles enregistrés : survivent au redémarrage, réutilisables sur d'autres fichiers.
  app.get<{ Params: { id: string } }>('/api/datasets/:id/ml/models', async (req) => {
    const meta = await dataset(req.params.id)
    return demo ? [] : models.list(meta.id)
  })
  app.get('/api/ml/models', async () => (demo ? [] : models.list()))

  app.post<{ Params: { id: string }; Body: { name?: string; datasetId?: string } }>('/api/ml/models/:id/save', async (req) => {
    noDemo()
    const meta = await dataset(String(req.body?.datasetId ?? ''))
    const name = String(req.body?.name ?? '').trim().slice(0, 120)
    if (!name) throw new HttpError(400, 'Donnez un nom au modèle.')
    const info = await models.save(req.params.id, name, meta)
    if (!info) throw new HttpError(404, 'Modèle expiré : relancez l’entraînement avant de l’enregistrer.')
    return info
  })

  app.delete<{ Params: { id: string } }>('/api/ml/models/:id', async (req, reply) => {
    noDemo()
    await models.remove(req.params.id)
    return reply.status(204).send()
  })

  /** Applique un modèle à toutes les lignes d'un jeu de données (200 000 au plus). */
  async function score(modelId: string, datasetId: string) {
    const m = await model(modelId)
    const meta = await dataset(datasetId)
    const r = await (await db(meta.id)).query('SELECT * FROM data', 200_000)
    const names = r.columns.map((c) => c.name)
    const objects = r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])))
    const out = scoreRows(m, objects)
    const present = new Set(names)
    return { meta, m, r, names, out, missing: m.encodings.map((e) => e.name).filter((n) => !present.has(n)) }
  }

  app.get<{ Params: { id: string }; Querystring: { dataset?: string } }>('/api/ml/models/:id/score', async (req) => {
    const { meta, m, r, names, out, missing } = await score(req.params.id, String(req.query.dataset ?? ''))
    const predicted = out.values.map((v) => v[0])
    let distribution: { value: string; rows: number }[] | null = null
    let stats: { mean: number; min: number; max: number } | null = null
    if (m.target.task === 'regression') {
      const nums = predicted.map(Number)
      stats = { mean: nums.reduce((a, b) => a + b, 0) / Math.max(1, nums.length), min: Math.min(...nums), max: Math.max(...nums) }
    } else {
      const counts = new Map<string, number>()
      predicted.forEach((v) => counts.set(String(v), (counts.get(String(v)) ?? 0) + 1))
      distribution = [...counts].map(([value, rows]) => ({ value, rows })).sort((a, b) => b.rows - a.rows)
    }
    return {
      dataset: { id: meta.id, name: meta.name }, total: r.rows.length, truncated: r.truncated, missing,
      task: m.target.task, target: m.target.name, distribution, stats,
      preview: {
        columns: [...out.columns.map((name) => ({ name, type: typeof out.values[0]?.[0] === 'number' ? 'DOUBLE' : 'VARCHAR' })), ...r.columns],
        rows: r.rows.slice(0, 15).map((row, i) => [...out.values[i], ...row]),
        truncated: r.rows.length > 15,
      },
      columns: names.length,
    }
  })

  app.get<{ Params: { id: string }; Querystring: { dataset?: string } }>('/api/ml/models/:id/score.csv', async (req, reply) => {
    const { meta, r, out } = await score(req.params.id, String(req.query.dataset ?? ''))
    const header = [...r.columns.map((c) => c.name), ...out.columns].map(csvCell).join(';')
    const lines = r.rows.map((row, i) => [...row, ...out.values[i]].map(csvCell).join(';'))
    const base = meta.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'donnees'
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${base}_predictions.csv"`)
      .send('\uFEFF' + [header, ...lines].join('\r\n'))
  })

  app.post<{ Params: { id: string }; Body: { date?: string; value?: string; agg?: string; grain?: string; periods?: number } }>(
    '/api/datasets/:id/ml/forecast', async (req) => {
      const meta = await dataset(req.params.id)
      const [d, p] = await Promise.all([db(meta.id), profile(meta.id)])
      return forecastSeries(d, p, String(req.body?.date ?? ''), String(req.body?.value ?? ''),
        { agg: req.body?.agg, grain: req.body?.grain, periods: req.body?.periods ? Number(req.body.periods) : undefined })
    })

  // ── Tableau de bord (éléments épinglés) ───────────────────────────────────────────────────
  // Démo : le tableau de bord vit seulement dans le navigateur du visiteur ; rien n'est gardé ici.
  app.get<{ Params: { id: string } }>('/api/datasets/:id/dashboard', async (req) => {
    const meta = await dataset(req.params.id)
    return demo ? [] : store.listPins(meta.id)
  })

  app.post<{ Params: { id: string }; Body: Partial<Pin> }>('/api/datasets/:id/dashboard', async (req) => {
    noDemo()
    const meta = await dataset(req.params.id)
    const b = req.body ?? {}
    if (!['chart', 'table', 'text'].includes(String(b.kind))) throw new HttpError(400, 'Type d’élément inconnu.')
    if (b.kind === 'chart' && !b.chart) throw new HttpError(400, 'Graphique manquant.')
    if (b.kind === 'table' && !b.table) throw new HttpError(400, 'Tableau manquant.')
    if (b.kind === 'text' && !String(b.text ?? '').trim()) throw new HttpError(400, 'Texte manquant.')
    const pins = await store.listPins(meta.id)
    if (pins.length >= 60) throw new HttpError(400, 'Tableau de bord plein (60 éléments) : retirez-en avant d’en ajouter.')
    const key = String(b.key ?? '').slice(0, 200)
    const existing = key ? pins.find((p) => p.key === key) : undefined
    if (existing) return existing
    const pin: Pin = {
      id: randomUUID(), key, kind: b.kind as Pin['kind'],
      title: String(b.title ?? '').trim().slice(0, 160) || 'Sans titre',
      chart: b.kind === 'chart' ? b.chart : undefined,
      table: b.table ? { ...b.table, rows: b.table.rows.slice(0, 200) } : undefined,
      text: b.kind === 'text' ? String(b.text).slice(0, 20_000) : undefined,
      sql: b.sql ? String(b.sql).slice(0, 10_000) : undefined,
      wide: b.kind === 'table' || b.kind === 'text' ? true : !!b.wide,
      source: String(b.source ?? '').slice(0, 200),
      createdAt: new Date().toISOString(),
    }
    pins.push(pin)
    await store.savePins(meta.id, pins)
    return pin
  })

  app.patch<{ Params: { id: string; pin: string }; Body: { title?: string; note?: string; wide?: boolean } }>(
    '/api/datasets/:id/dashboard/:pin', async (req) => {
      noDemo()
      const meta = await dataset(req.params.id)
      const pins = await store.listPins(meta.id)
      const pin = pins.find((p) => p.id === req.params.pin)
      if (!pin) throw new HttpError(404, 'Élément introuvable.')
      const b = req.body ?? {}
      if (typeof b.title === 'string' && b.title.trim()) pin.title = b.title.trim().slice(0, 160)
      if (typeof b.note === 'string') pin.note = b.note.slice(0, 2000) || undefined
      if (typeof b.wide === 'boolean') pin.wide = b.wide
      await store.savePins(meta.id, pins)
      return pin
    })

  app.delete<{ Params: { id: string; pin: string } }>('/api/datasets/:id/dashboard/:pin', async (req, reply) => {
    noDemo()
    const meta = await dataset(req.params.id)
    await store.savePins(meta.id, (await store.listPins(meta.id)).filter((p) => p.id !== req.params.pin))
    return reply.status(204).send()
  })

  app.put<{ Params: { id: string }; Body: { order?: string[] } }>('/api/datasets/:id/dashboard/order', async (req) => {
    noDemo()
    const meta = await dataset(req.params.id)
    const pins = await store.listPins(meta.id)
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : []
    const rank = (p: Pin) => { const i = order.indexOf(p.id); return i < 0 ? order.length + pins.indexOf(p) : i }
    pins.sort((a, b) => rank(a) - rank(b))
    await store.savePins(meta.id, pins)
    return pins
  })

  // ── Conversations ─────────────────────────────────────────────────────────────────────────
  async function conversation(id: string): Promise<Conversation> {
    const c = await store.getConversation(id).catch(() => null)
    if (!c) throw new HttpError(404, 'Conversation introuvable.')
    return c
  }

  // Démo : les analyses vivent dans la session du visiteur (mémoire), jamais sur le disque ni chez un autre visiteur.
  app.get<{ Params: { id: string } }>('/api/datasets/:id/conversations', async (req) => {
    await dataset(req.params.id)
    if (!demo) return store.listConversations(req.params.id)
    return [...(sessions.find(req)?.conversations.values() ?? [])]
      .filter((c) => c.datasetId === req.params.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...rest }) => ({ ...rest, turnCount: turns.length }))
  })

  app.post<{ Params: { id: string } }>('/api/datasets/:id/conversations', async (req, reply) => {
    await dataset(req.params.id)
    return demo ? sessions.createConversation(sessions.get(req, reply), req.params.id) : store.createConversation(req.params.id)
  })

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req) =>
    (demo ? demoConversation(sessions.find(req), req.params.id) : conversation(req.params.id)))

  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/conversations/:id', async (req) => {
    const c = demo ? demoConversation(sessions.find(req), req.params.id) : await conversation(req.params.id)
    const title = String(req.body?.title ?? '').trim().slice(0, 120)
    if (title) {
      c.title = title
      if (demo) c.updatedAt = new Date().toISOString()
      else await store.saveConversation(c)
    }
    return c
  })

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    if (demo) sessions.find(req)?.conversations.delete(req.params.id)
    else await store.deleteConversation(req.params.id)
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string }; Body: { text?: string; label?: string; engine?: string; model?: string } }>(
    '/api/conversations/:id/messages', async (req, reply) => {
      const conv = demo ? demoConversation(sessions.find(req), req.params.id) : await conversation(req.params.id)
      const meta = await dataset(conv.datasetId)
      const question = String(req.body?.text ?? '').trim()
      if (!question) throw new HttpError(400, 'Message vide.')
      // Démo : Ollama seulement, avec le modèle du serveur ; Claude refusé, clé transmise par l'en-tête ignorée.
      if (demo && req.body?.engine === 'claude') throw new HttpError(403, DEMO_CLAUDE_OFF)
      if (demo && question.length > 2000) throw new HttpError(400, 'Question trop longue pour la démo (2 000 caractères au plus).')
      const engine = !demo && req.body?.engine === 'claude' ? 'claude' : 'ollama'
      const model = demo ? await serverModel() : String(req.body?.model ?? (engine === 'claude' ? config.claudeModel : config.ollamaModel))
      const apiKey = demo ? '' : config.anthropicApiKey ?? String(req.headers['x-anthropic-key'] ?? '')
      const plan = engine === 'claude' && !!config.claudeOauthToken
      if (engine === 'claude' && !plan && !apiKey) throw new HttpError(400, 'Claude non configuré : forfait (CLAUDE_CODE_OAUTH_TOKEN) ou clé API requis.')

      const [d, p] = await Promise.all([db(meta.id), profile(meta.id)])
      const controller = new AbortController()
      req.raw.on('close', () => { if (!reply.raw.writableEnded) controller.abort() })
      // Démo : le départ du visiteur (connexion fermée) libère sa place dans la file ou arrête sa question.
      // L'événement « close » de la requête est déjà passé à ce stade (corps lu) : on écoute la réponse.
      if (demo) reply.raw.on('close', () => { if (!reply.raw.writableEnded) controller.abort() })

      // Démo : limite par visiteur, puis une seule question à la fois sur l'instance (file courte).
      const ip = demo ? clientIp(req) : ''
      let admission: ReturnType<SingleSlot['enter']> = null
      if (demo) {
        if (conv.turns.length >= DEMO_LIMITS.maxTurns) {
          throw new HttpError(400, `Cette analyse compte déjà ${DEMO_LIMITS.maxTurns} questions : une nouvelle analyse permet de continuer.`)
        }
        const wait = questionLimit.waitMinutes(ip)
        if (wait) {
          throw new HttpError(429, `Limite de la démo atteinte : ${config.demoQuestionsPerHour} questions par heure et par visiteur. Nouvel essai possible dans ${wait} min.`)
        }
        admission = slot.enter(controller.signal)
        if (!admission) throw new HttpError(503, DEMO_BUSY)
        admission.ready.catch(() => {}) // rejet traité plus bas (attente trop longue ou visiteur parti)
        questionLimit.take(ip)
        // À partir d'ici, plus rien ne doit échouer avant le bloc try qui libère la place.
      }

      const turn: Turn = {
        id: `turn-${Date.now().toString(36)}`, question, label: req.body?.label ? String(req.body.label) : undefined,
        blocks: [], engine: plan ? 'claude-forfait' : engine, model, createdAt: new Date().toISOString(),
      }
      const history = buildHistory(conv.turns)
      if (!conv.turns.length) conv.title = (turn.label ?? question).slice(0, 80)
      conv.turns.push(turn)

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

      // Démo : longueur totale du texte des réponses bornée.
      let answerChars = 0
      const onEvent = (e: AgentEvent) => {
        if (demo && e.type === 'text') {
          if (answerChars >= DEMO_LIMITS.maxAnswerChars) return
          const room = DEMO_LIMITS.maxAnswerChars - answerChars
          answerChars += e.text.length
          if (e.text.length > room) e = { type: 'text', text: `${e.text.slice(0, room)}\n\n… (réponse tronquée dans la démo)` }
        }
        if (e.type === 'text') turn.blocks.push({ kind: 'text', text: e.text })
        else if (e.type === 'tool_start') turn.blocks.push({ kind: 'tool', id: e.id, name: e.name, input: e.input })
        else {
          const b = turn.blocks.find((x): x is Extract<Block, { kind: 'tool' }> => x.kind === 'tool' && x.id === e.id)
          if (b) b.result = e.result
        }
        send(e.type, e)
      }

      let started = Date.now()
      let release: (() => void) | null = null
      let deadline: AbortSignal | null = null
      try {
        if (admission) {
          if (admission.queued) send('queued', { message: 'Une autre question est en cours sur la démo : la vôtre suit.' })
          try {
            release = await admission.ready
          } catch (err) {
            if (err instanceof DemoBusyError) questionLimit.refund(ip)
            throw err
          }
          started = Date.now()
          deadline = AbortSignal.timeout(DEMO_LIMITS.turnTimeoutMs)
        }
        const opts = {
          system: `${SYSTEM_PROMPT}\n\n--- DONNÉES ---\n${profileForPrompt(meta.name, p, meta)}${linkedForPrompt(meta, await linked(meta))}`,
          history, question, ctx: { db: d, profile: p }, onEvent,
          signal: deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal,
          ...(demo ? { maxSteps: DEMO_LIMITS.maxSteps, callTimeoutMs: DEMO_LIMITS.callTimeoutMs, maxOutputTokens: DEMO_LIMITS.maxOutputTokens } : {}),
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
        const late = !aborted && !!deadline?.aborted
        const known = err instanceof EngineError || err instanceof DemoBusyError
        turn.error = aborted ? 'Analyse arrêtée.' : late ? DEMO_TIMEOUT
          : known ? err.message : `Erreur : ${err instanceof Error ? err.message : String(err)}`
        if (!aborted && !late && !known) app.log.error(err)
        send('error', { message: turn.error })
      } finally {
        release?.()
        clearInterval(ping)
        if (demo) conv.updatedAt = new Date().toISOString() // session en mémoire : rien n'est écrit
        else {
          await store.saveConversation(conv).catch((e) => app.log.error(e))
          await store.touchDataset(meta.id).catch(() => null)
        }
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

interface KeyCheck { column: string; other: string; matchShare: number; uniqueInOther: boolean; distinct: number }

/** Colonnes de même nom (sans tenir compte de la casse) dans deux jeux : clés de jointure possibles. */
function commonColumns(a: DatasetMeta, b: DatasetMeta): { column: string; other: string }[] {
  const byName = new Map(b.columns.map((c) => [c.name.toLowerCase(), c.name]))
  return a.columns.filter((c) => byName.has(c.name.toLowerCase())).map((c) => ({ column: c.name, other: byName.get(c.name.toLowerCase())! }))
}

/** Nom de table SQL proposé pour un fichier lié (« Clients de la boutique » → clients_de_la_boutique). */
function tableName(name: string, taken: DatasetLink[]): string {
  let base = name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'table'
  if (/^[0-9]/.test(base)) base = `t_${base}`
  if (base === 'data') base = 'data_2'
  let out = base, i = 2
  while (taken.some((l) => l.table === out)) out = `${base}_${i++}`
  return out
}

function linkedForPrompt(meta: DatasetMeta, links: { link: DatasetLink; meta: DatasetMeta }[]): string {
  if (!links.length) return ''
  const lines = ['', '', 'Tables liées (fichiers importés à croiser avec `data` par jointure) :']
  for (const { link, meta: m } of links) {
    const cols = m.columns.slice(0, 40).map((c) => `"${c.name}" (${c.type})`).join(', ')
    const keys = commonColumns(meta, m).map((k) => `data."${k.column}" = ${link.table}."${k.other}"`)
    lines.push(`- table \`${link.table}\` (« ${m.name} », ${m.rows} lignes) : ${cols}${m.columns.length > 40 ? '…' : ''}`)
    lines.push(keys.length ? `  Clé(s) de jointure probable(s) : ${keys.join(' ; ')}.` : '  Aucune colonne commune : demande à l’utilisateur comment relier les tables.')
  }
  lines.push('Pour croiser, utilise JOIN dans run_sql / create_chart. Attention aux jointures qui multiplient les lignes : agrège d’abord si la clé n’est pas unique.')
  return lines.join('\n')
}

/** Cellule CSV au format français (point-virgule, virgule décimale). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v)
  return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
