// Démo publique (DATAMIND_DEMO=1) : écritures refusées, visiteurs isolés, IA bornée, Claude coupé.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { DEMO_BUSY, DEMO_CLAUDE_OFF, DEMO_LIMITS, DEMO_REFUSED, DEMO_WRITE_ALLOWED, HourlyLimit, SingleSlot } from '../src/demo.js'
import { tempStore } from './helpers.js'

type App = Awaited<ReturnType<typeof buildApp>>
type RunEngine = NonNullable<Parameters<typeof buildApp>[0]>['runEngine']

let tmp: Awaited<ReturnType<typeof tempStore>>
let app: App
let engineCalls: { engine: string; model: string; apiKey: string; maxSteps?: number; callTimeoutMs?: number; maxOutputTokens?: number }[] = []
/** Comportement du moteur simulé, remplaçable par test. */
let engine: RunEngine = async (_e, _m, opts) => { opts.onEvent({ type: 'text', text: 'Réponse fixe.' }); return { inputTokens: 1, outputTokens: 1 } }

const demoConfig = () => ({
  ...config, dataDir: tmp.dir, demo: true, demoQuestionsPerHour: 3,
  // Présents dans l'environnement du serveur : doivent être ignorés.
  claudeOauthToken: 'sk-ant-oat01-jeton-personnel', anthropicApiKey: 'sk-ant-api03-cle', defaultEngine: 'claude' as const,
})

// Aucun Ollama réel : la liste des modèles vient d'un faux /api/tags.
function stubOllamaTags() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ model: 'llama3.1:latest' }, { model: 'qwen2.5:72b' }] }), { status: 200 })
    }
    throw new Error(`appel réseau inattendu : ${url}`)
  }))
}

beforeAll(async () => {
  tmp = await tempStore()
  stubOllamaTags()
  app = await buildApp({
    config: demoConfig(),
    runEngine: async (e, m, opts, apiKey) => {
      engineCalls.push({ engine: e, model: m, apiKey, maxSteps: opts.maxSteps, callTimeoutMs: opts.callTimeoutMs, maxOutputTokens: opts.maxOutputTokens })
      return engine!(e, m, opts, apiKey)
    },
  })
})
afterAll(async () => { vi.unstubAllGlobals(); await app.close(); await tmp.cleanup() })
afterEach(() => { engineCalls = [] })

/** Un visiteur : son cookie de session et son adresse (derrière le proxy de bouclage par défaut). */
function visitor(ip: string) {
  let cookie = ''
  const req = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as 'GET', url, payload: payload as object,
      headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...headers },
    })
    const set = res.headers['set-cookie']
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]
    return res
  }
  return { req, get cookie() { return cookie } }
}

/** Instantané du dossier de données : chemins, tailles et dates de modification. */
async function snapshot(dir = tmp.dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    const s = await stat(path)
    out.push(`${path} ${entry.isFile() ? s.size : 'd'} ${s.mtimeMs}`)
  }
  return out.sort()
}

/** Toutes les routes de l'API (méthode + motif), lues dans l'arbre de Fastify. */
function routes(): { method: string; url: string }[] {
  const stack: string[] = []
  const out: { method: string; url: string }[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const at = line.indexOf('── ')
    if (at < 0) continue
    const depth = (at - 1) / 4
    const m = line.slice(at + 3).match(/^(\S+) \(([^)]+)\)/)
    const segment = m ? m[1] : line.slice(at + 3).trim()
    stack[depth] = (depth ? stack[depth - 1] : '') + segment
    stack.length = depth + 1
    if (m) for (const method of m[2].split(', ')) out.push({ method, url: stack[depth] })
  }
  return out
}

describe('démo : données', () => {
  it('charge tous les jeux d’exemple au démarrage, chaque visiteur ne voit que ceux qu’il a ouverts', async () => {
    const a = visitor('198.51.100.1')
    expect((await a.req('GET', '/api/datasets')).json()).toEqual([])
    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    expect(ds).toMatchObject({ sample: true, fileName: 'ventes.csv' })
    expect(a.cookie).toMatch(/^datamind_demo=[\w-]{43}$/)
    expect((await a.req('GET', '/api/datasets')).json().map((d: { id: string }) => d.id)).toEqual([ds.id])
    expect((await visitor('198.51.100.2').req('GET', '/api/datasets')).json()).toEqual([])
    // Lecture libre des données d'exemple.
    expect((await a.req('GET', `/api/datasets/${ds.id}/rows?limit=5`)).json().rows).toHaveLength(5)
    expect((await a.req('POST', `/api/datasets/${ds.id}/query`, { sql: 'SELECT count(*) AS n FROM data' })).json().rows[0][0]).toBe(30)
  })

  it('aucune route d’écriture hors liste blanche : 403 et message clair, rien d’écrit sur le disque', async () => {
    const a = visitor('198.51.100.3')
    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    const before = await snapshot()
    const all = routes()
    expect(all.length).toBeGreaterThan(30)
    const writes = all.filter((r) => !['GET', 'HEAD'].includes(r.method) && !DEMO_WRITE_ALLOWED.has(`${r.method} ${r.url}`))
    // Liste attendue : toute nouvelle route d'écriture est refusée d'office et apparaît ici.
    expect(writes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'DELETE /api/datasets/:id',
      'DELETE /api/datasets/:id/dashboard/:pin',
      'DELETE /api/ml/models/:id',
      'PATCH /api/datasets/:id',
      'PATCH /api/datasets/:id/dashboard/:pin',
      'POST /api/datasets',
      'POST /api/datasets/:id/clean',
      'POST /api/datasets/:id/dashboard',
      'POST /api/datasets/:id/sheet',
      'POST /api/ml/models/:id/save',
      'PUT /api/datasets/:id/dashboard/order',
      'PUT /api/datasets/:id/links',
    ])
    const fill = (url: string) => url.replace(':id', ds.id).replace(':pin', 'x').replace(':file', 'ventes.csv')
    const bodies: Record<string, unknown> = {
      'PATCH /api/datasets/:id': { name: 'Renommé' },
      'POST /api/datasets/:id/clean': { steps: [{ kind: 'dedupe', columns: [] }] },
      'PUT /api/datasets/:id/links': { links: [] },
      'POST /api/datasets/:id/dashboard': { kind: 'text', title: 't', text: 'x' },
    }
    for (const r of writes) {
      const res = await a.req(r.method, fill(r.url), bodies[`${r.method} ${r.url}`] ?? {})
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403)
      expect(res.json().error).toBe(DEMO_REFUSED)
    }
    // Envoi d'un vrai fichier : refusé avant la lecture du corps.
    const boundary = '----demo'
    const upload = await a.req('POST', '/api/datasets',
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n\r\n--${boundary}--\r\n`,
      { 'content-type': `multipart/form-data; boundary=${boundary}` })
    expect(upload.statusCode).toBe(403)
    // Fonctions absentes de la démo, même en lecture.
    expect((await a.req('GET', `/api/datasets/${ds.id}/links/suggest?other=${ds.id}`)).statusCode).toBe(403)
    expect((await a.req('GET', `/api/ml/models/abc/score?dataset=${ds.id}`)).statusCode).toBe(403)
    expect((await a.req('GET', `/api/ml/models/abc/score.csv?dataset=${ds.id}`)).statusCode).toBe(403)
    expect((await a.req('GET', '/api/ml/models')).json()).toEqual([])
    expect((await a.req('GET', `/api/datasets/${ds.id}/dashboard`)).json()).toEqual([])
    expect((await a.req('GET', `/api/datasets/${ds.id}`)).json().name).toBe('Petites ventes')
    expect(await snapshot()).toEqual(before)
  })

  it('les routes autorisées n’écrivent rien non plus (calculs, analyses, question)', async () => {
    const a = visitor('198.51.100.4')
    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    const before = await snapshot()
    await a.req('GET', `/api/datasets/${ds.id}`)
    const train = (await a.req('POST', `/api/datasets/${ds.id}/ml/train`, { target: 'montant' })).json()
    expect(train.id).toBeTruthy()
    expect((await a.req('POST', `/api/ml/models/${train.id}/predict`, { values: {} })).statusCode).toBe(200)
    const conv = (await a.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
    await a.req('PATCH', `/api/conversations/${conv.id}`, { title: 'Mon analyse' })
    const res = await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'Combien de ventes ?' })
    expect(res.body).toContain('event: done')
    await a.req('DELETE', `/api/conversations/${conv.id}`)
    expect(await snapshot()).toEqual(before)
  })

  it('les jeux importés hors démo restent invisibles', async () => {
    const { importText } = await import('./helpers.js')
    const { Store } = await import('../src/store.js')
    const priv = await importText(new Store(tmp.dir), 'prive.csv', 'client,solde\nDupont,1200\n')
    const a = visitor('198.51.100.5')
    expect((await a.req('GET', `/api/datasets/${priv.id}`)).statusCode).toBe(404)
    expect((await a.req('GET', `/api/datasets/${priv.id}/export.csv`)).statusCode).toBe(404)
    expect((await a.req('POST', `/api/datasets/${priv.id}/query`, { sql: 'SELECT * FROM data' })).statusCode).toBe(404)
  })
})

describe('démo : isolement des visiteurs', () => {
  it('un visiteur ne voit ni ne modifie les analyses d’un autre', async () => {
    const a = visitor('203.0.113.10'), b = visitor('203.0.113.11')
    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    await b.req('POST', '/api/samples/ventes.csv')
    const conv = (await a.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
    await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'Question privée de A' })
    expect((await a.req('GET', `/api/datasets/${ds.id}/conversations`)).json()).toHaveLength(1)
    expect((await a.req('GET', `/api/conversations/${conv.id}`)).json().turns[0].question).toBe('Question privée de A')

    expect((await b.req('GET', `/api/datasets/${ds.id}/conversations`)).json()).toEqual([])
    expect((await b.req('GET', `/api/conversations/${conv.id}`)).statusCode).toBe(404)
    expect((await b.req('PATCH', `/api/conversations/${conv.id}`, { title: 'pris' })).statusCode).toBe(404)
    expect((await b.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'intrus' })).statusCode).toBe(404)
    await b.req('DELETE', `/api/conversations/${conv.id}`)
    // Sans cookie, ou avec un cookie inventé : rien.
    const anon = await app.inject(`/api/conversations/${conv.id}`)
    expect(anon.statusCode).toBe(404)
    const forged = await app.inject({ url: `/api/conversations/${conv.id}`, headers: { cookie: `datamind_demo=${'A'.repeat(43)}` } })
    expect(forged.statusCode).toBe(404)
    expect((await a.req('GET', `/api/conversations/${conv.id}`)).json().title).toBe('Question privée de A')
  })

  it('le cookie de session est HttpOnly, SameSite=Lax, Secure derrière le proxy HTTPS', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/samples/ventes.csv', headers: { 'x-forwarded-proto': 'https' } })
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Secure/)
    expect(cookie).toMatch(/Max-Age=7200/)
  })
})

describe('démo : IA', () => {
  it('Claude est coupé même avec un jeton : configuration, refus, clé ignorée', async () => {
    const a = visitor('192.0.2.20')
    const cfg = (await a.req('GET', '/api/config')).json()
    expect(cfg.claude).toMatchObject({ plan: false, serverKey: false, models: [] })
    expect(cfg.defaultEngine).toBe('ollama')
    expect(cfg.ollama.models).toEqual(['llama3.1:latest']) // le modèle du serveur seulement
    expect(cfg.demo).toEqual({ questionsPerHour: 3, returnUrl: null })
    expect(cfg.formats).toEqual([])
    expect(JSON.stringify(cfg)).not.toMatch(/sk-ant/)

    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    const conv = (await a.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
    const claude = await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'q', engine: 'claude', model: 'claude-opus-5-5' })
    expect(claude.statusCode).toBe(403)
    expect(claude.json().error).toBe(DEMO_CLAUDE_OFF)
    // Clé passée par l'en-tête et modèle choisi par le visiteur : ignorés.
    await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'q', engine: 'ollama', model: 'qwen2.5:72b' }, { 'x-anthropic-key': 'sk-ant-visiteur' })
    expect(engineCalls).toEqual([{
      engine: 'ollama', model: 'llama3.1:latest', apiKey: '',
      maxSteps: DEMO_LIMITS.maxSteps, callTimeoutMs: DEMO_LIMITS.callTimeoutMs, maxOutputTokens: DEMO_LIMITS.maxOutputTokens,
    }])
    expect(DEMO_LIMITS.maxSteps).toBeLessThan(config.maxSteps)
    expect(DEMO_LIMITS.callTimeoutMs).toBeLessThan(config.ollamaTimeoutMs)
  })

  it('DATAMIND_DEMO=1 efface jeton et clé dès la lecture de la configuration', async () => {
    vi.stubEnv('DATAMIND_DEMO', '1')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-x')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-x')
    vi.stubEnv('DATAMIND_DEMO_QUESTIONS_PAR_HEURE', '7')
    vi.stubEnv('DATAMIND_DEMO_RETOUR', 'javascript:alert(1)')
    vi.resetModules()
    const fresh = (await import('../src/config.js')).config
    expect(fresh).toMatchObject({ demo: true, claudeOauthToken: undefined, anthropicApiKey: undefined, defaultEngine: 'ollama', demoQuestionsPerHour: 7, demoReturnUrl: '' })
    vi.stubEnv('DATAMIND_DEMO_RETOUR', 'https://portfolio.example.fr/')
    vi.stubEnv('DATAMIND_DEMO', '')
    vi.resetModules()
    const priv = (await import('../src/config.js')).config
    expect(priv).toMatchObject({ demo: false, claudeOauthToken: 'sk-ant-oat01-x', demoReturnUrl: 'https://portfolio.example.fr/' })
    vi.unstubAllEnvs()
  })

  it('limite les questions par adresse IP réelle ; X-Forwarded-For ignoré hors proxy de bouclage', async () => {
    // Derrière le proxy (connexion depuis 127.0.0.1) : l'adresse ajoutée par le proxy compte.
    const a = visitor('10.9.9.9, 198.51.100.50')
    const ds = (await a.req('POST', '/api/samples/ventes.csv')).json()
    const conv = (await a.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
    for (let i = 0; i < 3; i++) expect((await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: `q${i}` })).statusCode).toBe(200)
    const over = await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'une de trop' })
    expect(over.statusCode).toBe(429)
    expect(over.json().error).toMatch(/3 questions par heure/)
    // Même visiteur, première adresse de la liste changée (inventée par le client) : toujours limité.
    expect((await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'q' }, { 'x-forwarded-for': '1.1.1.1, 198.51.100.50' })).statusCode).toBe(429)
    // Une autre adresse derrière le proxy : son propre quota.
    expect((await a.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'q' }, { 'x-forwarded-for': '198.51.100.51' })).statusCode).toBe(200)

    // Connexion directe (pas le proxy de bouclage) : l'en-tête est ignoré, l'adresse de la connexion compte.
    const direct = async (xff: string) => app.inject({
      method: 'POST', url: `/api/conversations/${conv.id}/messages`, payload: { text: 'q' }, remoteAddress: '203.0.113.99',
      headers: { cookie: a.cookie, 'x-forwarded-for': xff },
    })
    for (let i = 0; i < 3; i++) expect((await direct(`192.0.2.${i}`)).statusCode).toBe(200)
    const blocked = await direct('192.0.2.200')
    expect(blocked.statusCode).toBe(429)
  })

  it('une seule question à la fois sur l’instance, file courte, puis « occupée »', async () => {
    let active = 0, maxActive = 0
    const gates: (() => void)[] = []
    engine = async (_e, _m, opts) => {
      active++; maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => gates.push(resolve))
      opts.onEvent({ type: 'text', text: 'ok' })
      active--
      return { inputTokens: 1, outputTokens: 1 }
    }
    const ask = async (ip: string) => {
      const v = visitor(ip)
      const ds = (await v.req('POST', '/api/samples/ventes.csv')).json()
      const conv = (await v.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
      return () => v.req('POST', `/api/conversations/${conv.id}/messages`, { text: `question de ${ip}` })
    }
    const senders = await Promise.all(['192.0.2.31', '192.0.2.32', '192.0.2.33', '192.0.2.34'].map(ask))
    const first = senders[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const second = senders[1](), third = senders[2]()
    await vi.waitFor(() => expect(engineCalls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    const fourth = await senders[3]() // file pleine (DEMO_LIMITS.queueSize = 2)
    expect(fourth.statusCode).toBe(503)
    expect(fourth.json().error).toBe(DEMO_BUSY)
    expect(gates).toHaveLength(1) // les deux autres attendent

    gates[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1]()
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    gates[2]()
    const [r1, r2, r3] = await Promise.all([first, second, third])
    expect(r1.body).not.toContain('event: queued')
    expect(r2.body).toContain('event: queued')
    expect(r3.body).toContain('event: done')
    expect(maxActive).toBe(1)
    // La place est libérée : une nouvelle question passe aussitôt.
    engine = async (_e, _m, opts) => { opts.onEvent({ type: 'text', text: 'ok' }); return { inputTokens: 1, outputTokens: 1 } }
    expect((await senders[3]()).body).toContain('event: done')
  })

  it('borne la longueur des réponses et libère la place après une erreur du moteur', async () => {
    const v = visitor('192.0.2.40')
    const ds = (await v.req('POST', '/api/samples/ventes.csv')).json()
    const conv = (await v.req('POST', `/api/datasets/${ds.id}/conversations`)).json()
    engine = async (_e, _m, opts) => {
      for (let i = 0; i < 5; i++) opts.onEvent({ type: 'text', text: 'x'.repeat(5000) })
      return { inputTokens: 1, outputTokens: 1 }
    }
    await v.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'longue' })
    const turn = (await v.req('GET', `/api/conversations/${conv.id}`)).json().turns[0]
    const text = turn.blocks.map((b: { text: string }) => b.text).join('')
    expect(text.length).toBeLessThan(DEMO_LIMITS.maxAnswerChars + 100)
    expect(text).toMatch(/réponse tronquée/)

    engine = async () => { throw new Error('panne') }
    expect((await v.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'panne' })).body).toContain('event: error')
    engine = async (_e, _m, opts) => { opts.onEvent({ type: 'text', text: 'ok' }); return { inputTokens: 1, outputTokens: 1 } }
    expect((await v.req('POST', `/api/conversations/${conv.id}/messages`, { text: 'reprise' })).body).toContain('event: done')
  })
})

describe('démo : outils de limitation', () => {
  it('fenêtre glissante d’une heure, avec remboursement', () => {
    let now = 0
    const limit = new HourlyLimit(2, () => now)
    limit.take('a'); limit.take('a')
    expect(limit.waitMinutes('a')).toBe(60)
    expect(limit.waitMinutes('b')).toBe(0)
    limit.refund('a')
    expect(limit.waitMinutes('a')).toBe(0)
    limit.take('a')
    now = 3_600_001
    expect(limit.waitMinutes('a')).toBe(0)
  })

  it('place unique : le visiteur parti quitte la file', async () => {
    const slot = new SingleSlot(1, 10_000)
    const first = slot.enter()!
    const release = await first.ready
    const ctrl = new AbortController()
    const second = slot.enter(ctrl.signal)!
    expect(second.queued).toBe(true)
    expect(slot.enter()).toBeNull()
    ctrl.abort()
    await expect(second.ready).rejects.toThrow(DEMO_BUSY)
    expect(slot.queued).toBe(0)
    release()
    expect(slot.busy).toBe(false)
  })
})
