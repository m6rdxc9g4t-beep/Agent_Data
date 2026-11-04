import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { extractJsonToolCall, extractSqlBlock, runOllama, STEP_LIMIT, type AgentEvent } from '../src/agent/engines.js'
import { runTool } from '../src/agent/tools.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { loadSample, tempStore } from './helpers.js'

const sample = await loadSample('ventes.csv')
afterAll(() => sample.cleanup())
afterEach(() => vi.unstubAllGlobals())

function fakeOllama(replies: Record<string, unknown>[]) {
  const calls: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    const message = replies.shift() ?? { role: 'assistant', content: 'fin' }
    return new Response(JSON.stringify({ message, prompt_eval_count: 10, eval_count: 5 }), { status: 200 })
  }))
  return calls
}

function run(question = 'q', maxSteps?: number) {
  const events: AgentEvent[] = []
  const p = runOllama({ system: 'sys', history: [], question, ctx: { db: sample.db, profile: sample.profile }, onEvent: (e) => events.push(e), maxSteps }, 'm')
  return { p, events }
}

describe('outils', () => {
  it('run_sql renvoie une table et un résumé lisible par le modèle', async () => {
    const out = await runTool('run_sql', { sql: 'SELECT count(*) AS n FROM data' }, { db: sample.db, profile: sample.profile })
    expect(out.ok).toBe(true)
    expect(out.summary).toContain('n\n30')
  })

  it('les erreurs sont renvoyées au modèle au lieu de casser la boucle', async () => {
    const out = await runTool('run_sql', { sql: 'SELECT colonne_absente FROM data' }, { db: sample.db, profile: sample.profile })
    expect(out.ok).toBe(false)
    expect(out.summary).toMatch(/^Erreur/)
    expect((await runTool('inconnu', {}, { db: sample.db, profile: sample.profile })).ok).toBe(false)
  })
})

describe('moteur Ollama', () => {
  it('exécute les appels d’outil natifs puis rend la réponse', async () => {
    const calls = fakeOllama([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_sql', arguments: { sql: 'SELECT count(*) AS n FROM data' } } }] },
      { role: 'assistant', content: 'Il y a **30** lignes.' },
    ])
    const { p, events } = run()
    expect(await p).toEqual({ inputTokens: 20, outputTokens: 10 })
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text'])
    expect(calls[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'run_sql' })
    expect(calls[0].tools.map((t: any) => t.function.name)).toContain('create_chart')
  })

  it('rattrape un appel d’outil écrit en JSON dans le texte', async () => {
    fakeOllama([
      { role: 'assistant', content: '{"name": "run_sql", "parameters": {"sql": "SELECT 2+2 AS r"}}' },
      { role: 'assistant', content: 'Résultat : 4' },
    ])
    const { p, events } = run()
    await p
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text'])
  })

  it('exécute une requête proposée en bloc ```sql``` une seule fois', async () => {
    const calls = fakeOllama([
      { role: 'assistant', content: 'Voici :\n```sql\nSELECT max(montant) AS m FROM data\n```' },
      { role: 'assistant', content: 'Le maximum est 2995.' },
    ])
    const { p, events } = run()
    await p
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_start', 'tool_end', 'text'])
    expect(calls[1].messages.at(-1).content).toMatch(/Résultat réel/)
  })

  it('s’arrête au nombre maximal d’étapes', async () => {
    const call = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_sql', arguments: '{"sql":"SELECT 1"}' } }] }
    fakeOllama([call, call, call])
    const { p, events } = run('q', 3)
    await p
    expect(events.at(-1)).toEqual({ type: 'text', text: STEP_LIMIT })
  })

  it('analyse les textes des petits modèles', () => {
    expect(extractJsonToolCall('```json\n{"name":"run_sql","arguments":{"sql":"SELECT 1"}}\n```')).toEqual({ name: 'run_sql', input: { sql: 'SELECT 1' } })
    expect(extractJsonToolCall('Bonjour')).toBeNull()
    expect(extractJsonToolCall('{"name":"autre","parameters":{}}')).toBeNull()
    expect(extractSqlBlock('x\n```sql\nSELECT 1\n```')).toBe('SELECT 1')
  })
})

describe('API', () => {
  it('importe un exemple, répond en flux et enregistre la conversation', async () => {
    const { dir, cleanup } = await tempStore()
    const app = await buildApp({
      config: { ...config, dataDir: dir },
      runEngine: async (_engine, _model, opts) => {
        const out = await import('../src/agent/tools.js').then((m) => m.runTool('run_sql', { sql: 'SELECT count(*) AS n FROM data' }, opts.ctx))
        opts.onEvent({ type: 'tool_start', id: 'a', name: 'run_sql', input: { sql: 'SELECT count(*) AS n FROM data' } })
        opts.onEvent({ type: 'tool_end', id: 'a', result: out })
        opts.onEvent({ type: 'text', text: '**Synthèse** : 402 clients.' })
        expect(opts.system).toContain('demo_complet.csv')
        return { inputTokens: 1, outputTokens: 2 }
      },
    })
    expect((await app.inject('/api/health')).json().status).toBe('ok')
    const ds = (await app.inject({ method: 'POST', url: '/api/samples/demo_complet.csv' })).json()
    expect(ds.rows).toBe(402)
    const detail = (await app.inject(`/api/datasets/${ds.id}`)).json()
    expect(detail.profile.quality.score).toBeGreaterThan(80)
    const rows = (await app.inject(`/api/datasets/${ds.id}/rows?limit=5&q=nord`)).json()
    expect(rows.total).toBe(109)
    expect((await app.inject(`/api/datasets/${ds.id}/charts`)).json().length).toBe(4)

    const conv = (await app.inject({ method: 'POST', url: `/api/datasets/${ds.id}/conversations` })).json()
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, payload: { text: 'Combien de clients ?', engine: 'ollama' } })
    expect(res.headers['content-type']).toMatch(/event-stream/)
    expect(res.body).toContain('event: tool_end')
    expect(res.body).toContain('event: done')
    const saved = (await app.inject(`/api/conversations/${conv.id}`)).json()
    expect(saved.title).toBe('Combien de clients ?')
    expect(saved.turns[0].blocks.map((b: any) => b.kind)).toEqual(['tool', 'text'])
    expect(saved.turns[0].blocks[0].result.table.rows[0][0]).toBe(402)

    // La liste est triée par dernière activité (ouverture ou analyse), pas par date d'import.
    const other = (await app.inject({ method: 'POST', url: '/api/samples/ventes.csv' })).json()
    expect((await app.inject('/api/datasets')).json()[0].id).toBe(other.id)
    await app.inject(`/api/datasets/${ds.id}`)
    const list = (await app.inject('/api/datasets')).json()
    expect(list[0].id).toBe(ds.id)
    expect(list[0].lastActivityAt).toBeTruthy()

    const csv = await app.inject(`/api/datasets/${ds.id}/export.csv`)
    expect(csv.body.split('\r\n')[0]).toContain('date;region')
    expect((await app.inject({ method: 'POST', url: '/api/samples/autre.csv' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}` })).statusCode).toBe(204)
    expect((await app.inject(`/api/datasets/${ds.id}`)).statusCode).toBe(404)
    await app.close()
    await cleanup()
  })
})
