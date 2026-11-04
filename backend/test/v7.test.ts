// Fonctions de la v7 : tableau de bord, fichiers liés, nettoyage appliqué, modèles enregistrés, dictionnaire, SQL relancé.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { tempStore } from './helpers.js'

type App = Awaited<ReturnType<typeof buildApp>>
let tmp: Awaited<ReturnType<typeof tempStore>>
let app: App
let prompts: string[] = []
const make = () => buildApp({
  config: { ...config, dataDir: tmp.dir },
  runEngine: async (_e, _m, opts) => { prompts.push(opts.system); return { inputTokens: 1, outputTokens: 1 } },
})

beforeAll(async () => {
  tmp = await tempStore()
  app = await make()
})
afterAll(async () => { await app.close(); await tmp.cleanup() })

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object })
const sample = async (file: string) => (await post(`/api/samples/${file}`)).json()

describe('tableau de bord', () => {
  it('épingle, déduplique, réordonne, modifie et retire', async () => {
    const ds = await sample('ventes.csv')
    const chart = { type: 'bar', title: 'CA', x: 'r', y: ['v'], data: { columns: ['r', 'v'], rows: [['a', 1]] } }
    const a = (await post(`/api/datasets/${ds.id}/dashboard`, { key: 'k1', kind: 'chart', title: 'CA', chart, source: 'test' })).json()
    const again = (await post(`/api/datasets/${ds.id}/dashboard`, { key: 'k1', kind: 'chart', title: 'CA', chart })).json()
    expect(again.id).toBe(a.id)
    const b = (await post(`/api/datasets/${ds.id}/dashboard`, { key: 'k2', kind: 'text', title: 'Note', text: 'Bonjour' })).json()
    expect(b.wide).toBe(true)
    expect((await post(`/api/datasets/${ds.id}/dashboard`, { kind: 'text', title: 'vide', text: ' ' })).statusCode).toBe(400)
    const order = (await app.inject({ method: 'PUT', url: `/api/datasets/${ds.id}/dashboard/order`, payload: { order: [b.id, a.id] } })).json()
    expect(order.map((p: { id: string }) => p.id)).toEqual([b.id, a.id])
    await app.inject({ method: 'PATCH', url: `/api/datasets/${ds.id}/dashboard/${a.id}`, payload: { title: 'Chiffre d’affaires', note: 'à suivre' } })
    await app.inject({ method: 'DELETE', url: `/api/datasets/${ds.id}/dashboard/${b.id}` })
    const pins = (await app.inject(`/api/datasets/${ds.id}/dashboard`)).json()
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ title: 'Chiffre d’affaires', note: 'à suivre' })
  })
})

describe('fichiers liés et SQL relancé', () => {
  it('propose la clé, lie la table et permet la jointure', async () => {
    const orders = await sample('ecommerce_commandes.csv')
    const clients = await sample('ecommerce_clients.csv')
    const sugg = (await app.inject(`/api/datasets/${orders.id}/links/suggest?other=${clients.id}`)).json()
    expect(sugg.table).toBe('clients_de_la_boutique')
    expect(sugg.keys[0]).toMatchObject({ column: 'client_id', matchShare: 1, uniqueInOther: true })

    const bad = await app.inject({ method: 'PUT', url: `/api/datasets/${orders.id}/links`, payload: { links: [{ id: clients.id, table: 'data' }] } })
    expect(bad.statusCode).toBe(400)
    await app.inject({ method: 'PUT', url: `/api/datasets/${orders.id}/links`, payload: { links: [{ id: clients.id, table: 'clients' }] } })

    const q = (await post(`/api/datasets/${orders.id}/query`, {
      sql: 'SELECT k.programme_fidelite, count(*) AS n FROM data JOIN clients k USING (client_id) GROUP BY 1 ORDER BY 1',
    })).json()
    expect(q.rows.reduce((s: number, r: number[]) => s + r[1], 0)).toBe(3200)
    expect((await post(`/api/datasets/${orders.id}/query`, { sql: 'DROP TABLE data' })).statusCode).toBe(400)

    // Le prompt de l'agent décrit la table liée et la clé de jointure, ainsi que le dictionnaire.
    await app.inject({ method: 'PATCH', url: `/api/datasets/${orders.id}`, payload: { descriptions: { montant: 'euros TTC' }, context: 'Boutique test' } })
    const conv = (await post(`/api/datasets/${orders.id}/conversations`)).json()
    prompts = []
    await post(`/api/conversations/${conv.id}/messages`, { text: 'Qui sont les meilleurs clients ?', engine: 'ollama' })
    expect(prompts[0]).toContain('table `clients`')
    expect(prompts[0]).toContain('data."client_id" = clients."client_id"')
    expect(prompts[0]).toContain('signification : euros TTC')
    expect(prompts[0]).toContain('Contexte donné par l\'utilisateur : Boutique test')
    expect(prompts[0]).toContain('Pour aller plus loin')

    // Supprimer le jeu lié retire le lien.
    await app.inject({ method: 'DELETE', url: `/api/datasets/${clients.id}` })
    expect((await app.inject(`/api/datasets/${orders.id}/links`)).json()).toEqual([])
  })
})

describe('nettoyage appliqué', () => {
  it('crée une version nettoyée et garde l’original', async () => {
    const lines = ['id;ville;montant;pays']
    for (let i = 0; i < 60; i++) lines.push(`${i};${i % 2 ? ' Lyon' : 'Paris '};${i % 7 ? `${100 + i},5` : '1 200,5'};France`)
    lines.push(lines[1], lines[2])
    const up = await app.inject({
      method: 'POST', url: '/api/datasets', headers: { 'content-type': 'multipart/form-data; boundary=X' },
      payload: `--X\r\nContent-Disposition: form-data; name="file"; filename="sale.csv"\r\nContent-Type: text/csv\r\n\r\n${lines.join('\n')}\r\n--X--\r\n`,
    })
    const ds = up.json()
    const plan = (await app.inject(`/api/datasets/${ds.id}/clean/plan`)).json()
    expect(plan.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(['trim', 'convert', 'drop_columns', 'dedupe']))
    const res = (await post(`/api/datasets/${ds.id}/clean`, { steps: plan.filter((s: { recommended: boolean }) => s.recommended) })).json()
    expect(res.report.join(' ')).toContain('2 doublon(s) supprimé(s)')
    expect(res.dataset).toMatchObject({ rows: 60, cleanedFrom: ds.id, name: 'sale (nettoyé)' })
    expect(res.dataset.columns.find((c: { name: string }) => c.name === 'montant').type).toBe('DOUBLE')
    expect(res.dataset.columns.some((c: { name: string }) => c.name === 'pays')).toBe(false)
    const rows = (await app.inject(`/api/datasets/${res.dataset.id}/rows?limit=3`)).json()
    expect(rows.rows[0]).toEqual([0, 'Paris', 1200.5])
    expect(rows.rows[1][1]).toBe('Lyon')
    expect((await app.inject(`/api/datasets/${ds.id}`)).json().rows).toBe(62)
  })
})

describe('modèles enregistrés', () => {
  it('survivent au redémarrage et prédisent un autre fichier', async () => {
    const ds = await sample('demo_complet.csv')
    const trained = (await post(`/api/datasets/${ds.id}/ml/train`, { target: 'churn', models: ['linear'] })).json()
    expect((await post(`/api/ml/models/${trained.id}/save`, { datasetId: ds.id, name: '' })).statusCode).toBe(400)
    const saved = (await post(`/api/ml/models/${trained.id}/save`, { datasetId: ds.id, name: 'Départ clients' })).json()
    expect(saved).toMatchObject({ name: 'Départ clients', datasetId: ds.id })

    await app.close()
    app = await make() // redémarrage : le modèle est relu sur disque
    const list = (await app.inject('/api/ml/models')).json()
    expect(list.map((m: { id: string }) => m.id)).toContain(trained.id)
    const one = (await post(`/api/ml/models/${trained.id}/predict`, { values: {} })).json()
    expect(one.probabilities).toHaveLength(2)

    const preview = (await app.inject(`/api/ml/models/${trained.id}/score?dataset=${ds.id}`)).json()
    expect(preview.total).toBe(402)
    expect(preview.preview.columns[0].name).toBe('churn_prédit')
    const csv = await app.inject(`/api/ml/models/${trained.id}/score.csv?dataset=${ds.id}`)
    const head = csv.body.replace(/^﻿/, '').split('\r\n')
    expect(head).toHaveLength(403)
    expect(head[0]).toMatch(/churn_prédit;probabilité_/)

    await app.inject({ method: 'DELETE', url: `/api/ml/models/${trained.id}` })
    await app.close()
    app = await make()
    expect((await post(`/api/ml/models/${trained.id}/predict`, { values: {} })).statusCode).toBe(404)
  })
})
