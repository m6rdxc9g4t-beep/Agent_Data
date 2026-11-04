import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import { kmeans } from '../src/analysis.js'
import { forecastSeries } from '../src/ml/timeseries.js'
import { predictOne, recentModel, trainModels } from '../src/ml/train.js'
import { autoCharts, buildChart, pickMeasure } from '../src/charts.js'
import { assertReadOnly, DatasetDb, QueryError } from '../src/db.js'
import { decodeText, ImportError, importFile, sniffDelimiter } from '../src/importer.js'
import { computeProfile } from '../src/profile.js'
import { importText, loadSample, tempStore } from './helpers.js'

describe('import', () => {
  it('lit les jeux d’exemple avec leurs types', async () => {
    const { meta, profile, cleanup } = await loadSample('ventes.csv')
    expect(meta.rows).toBe(30)
    expect(meta.columns.find((c) => c.name === 'date')?.type).toBe('DATE')
    expect(meta.columns.find((c) => c.name === 'montant')?.type).toBe('DOUBLE')
    expect(profile.columns.find((c) => c.name === 'region')?.kind).toBe('category')
    await cleanup()
  })

  it('gère le CSV français (point-virgule, virgule décimale, Windows-1252, dates jj/mm/aaaa)', async () => {
    const { store, cleanup } = await tempStore()
    const csv = 'Date;Ville;Montant\n03/01/2024;Besançon;1234,5\n04/01/2024;Paris;12,75\n'
    const meta = await importText(store, 'export.csv', Buffer.from(csv, 'latin1'))
    const db = await DatasetDb.open(store.parquetPath(meta.id))
    const r = await db.query('SELECT * FROM data ORDER BY 1')
    expect(r.columns.map((c) => c.type)).toEqual(['DATE', 'VARCHAR', 'DOUBLE'])
    expect(r.rows[0]).toEqual(['2024-01-03', 'Besançon', 1234.5])
    db.close()
    await cleanup()
  })

  it('détecte séparateur et encodage', () => {
    expect(sniffDelimiter('a;b;c\n1;2,5;3\n')).toBe(';')
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(sniffDelimiter('a,b\n"x;y",2\n')).toBe(',')
    expect(decodeText(Buffer.from('Élodie', 'latin1'))).toBe('Élodie')
    expect(decodeText(Buffer.from('﻿Élodie', 'utf8'))).toBe('Élodie')
  })

  it('importe JSON, JSON Lines et la feuille Excel choisie', async () => {
    const { store, cleanup } = await tempStore()
    expect((await importText(store, 'a.json', '[{"a":1},{"a":2}]')).rows).toBe(2)
    expect((await importText(store, 'a.jsonl', '{"a":1}\n{"a":2}\n{"a":3}\n')).rows).toBe(3)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], [1], [2]]), 'Un')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['y', 'z'], ['a', 3.5]]), 'Deux')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const meta = await importText(store, 'c.xlsx', buf)
    expect(meta.sheets).toEqual(['Un', 'Deux'])
    expect(meta.columns.map((c) => c.name)).toEqual(['x'])
    const again = await importFile(store, `${store.datasetDir(meta.id)}/source.xlsx`, 'c.xlsx', { sheet: 'Deux', existingId: meta.id })
    expect(again.columns.map((c) => c.name)).toEqual(['y', 'z'])
    await cleanup()
  })

  it('refuse les fichiers inexploitables', async () => {
    const { store, cleanup } = await tempStore()
    await expect(importText(store, 'x.pdf', '%PDF')).rejects.toBeInstanceOf(ImportError)
    await expect(importText(store, 'vide.csv', '')).rejects.toBeInstanceOf(ImportError)
    await expect(importText(store, 'entete.csv', 'a,b\n')).rejects.toBeInstanceOf(ImportError)
    await cleanup()
  })
})

describe('requêtes', () => {
  it('n’accepte que la lecture et coupe l’accès aux fichiers', async () => {
    const { db, cleanup } = await loadSample('ventes.csv')
    expect(() => assertReadOnly('DROP TABLE data')).toThrow(QueryError)
    expect(() => assertReadOnly("COPY data TO '/tmp/x.csv'")).toThrow(QueryError)
    await expect(db.safeQuery('SELECT 1; DROP TABLE data')).rejects.toBeInstanceOf(QueryError)
    await expect(db.safeQuery("SELECT * FROM read_csv_auto('/etc/passwd')")).rejects.toBeInstanceOf(QueryError)
    await expect(db.safeQuery("SELECT * FROM read_text('/etc/hostname')")).rejects.toBeInstanceOf(QueryError)
    const r = await db.safeQuery('-- commentaire\nSELECT region, round(sum(montant), 2) AS total FROM data GROUP BY 1 ORDER BY 2 DESC;')
    expect(r.rows[0][0]).toBe('Nord')
    expect(typeof r.rows[0][1]).toBe('number')
    const s = await db.safeQuery('SUMMARIZE data')
    expect(s.rows.length).toBe(8)
    await cleanup()
  })

  it('tronque les résultats volumineux', async () => {
    const { db, cleanup } = await loadSample('demo_complet.csv')
    const r = await db.safeQuery('SELECT * FROM data', 50)
    expect(r.rows.length).toBe(50)
    expect(r.truncated).toBe(true)
    await cleanup()
  })
})

describe('profil, graphiques, analyses', () => {
  it('calcule un score de qualité et repère les problèmes', async () => {
    const { store, cleanup } = await tempStore()
    const meta = await importText(store, 'q.csv', 'a,b,c\n1,x,7\n1,x,7\n,y,7\n,z,7\n,t,7\n')
    const db = await DatasetDb.open(store.parquetPath(meta.id))
    const p = await computeProfile(db)
    expect(p.quality.duplicateRows).toBe(1)
    expect(p.quality.constantColumns).toContain('c')
    expect(p.quality.highMissing.map((m) => m.column)).toContain('a')
    expect(p.quality.score).toBeLessThan(80)
    db.close()
    await cleanup()
  })

  it('produit des graphiques automatiques et des spécifications valides', async () => {
    const { db, profile, cleanup } = await loadSample('ventes.csv')
    expect(pickMeasure(profile.columns).col?.name).toBe('montant')
    const charts = await autoCharts(db, profile)
    expect(charts.map((c) => c.type)).toEqual(['area', 'horizontal_bar', 'pie', 'histogram'])
    const spec = await buildChart(db, { type: 'line', title: 't', x: 'region', y: ['total'], sql: 'SELECT region, sum(montant) AS total FROM data GROUP BY 1' })
    expect(spec.data.columns).toEqual(['region', 'total'])
    await expect(buildChart(db, { type: 'bar', title: 't', x: 'absente', sql: 'SELECT region FROM data' })).rejects.toThrow(/absente/)
    await cleanup()
  })

  it('segmente les clients', async () => {
    const { db, profile, cleanup } = await loadSample('demo_complet.csv')
    const seg = await kmeans(db, profile, ['depenses_totales', 'nb_commandes', 'anciennete_mois'])
    expect(seg.table.rows.length).toBeGreaterThanOrEqual(2)
    expect(seg.summary).toMatch(/silhouette/)
    await cleanup()
  })
})

describe('apprentissage automatique', () => {
  it('compare quatre modèles en régression et bat la référence', async () => {
    const { db, profile, cleanup } = await loadSample('demo_complet.csv')
    const r = await trainModels(db, profile, 'depenses_totales')
    expect(r.task).toBe('regression')
    expect(r.models.map((m) => m.kind)).toEqual(['baseline', 'linear', 'gbm', 'mlp'])
    const best = r.models.find((m) => m.kind === r.best)!
    expect(best.score).toBeGreaterThan(0.7) // R² sur le jeu de test
    expect(r.models[0].score).toBeLessThan(0.1)
    expect(r.importance.data.rows[0][0]).toBe('panier_moyen')
    expect(r.quality.type).toBe('scatter')
    const out = predictOne(recentModel(r.id)!, Object.fromEntries(r.simulator.map((f) => [f.name, f.default])))
    expect(typeof out?.value).toBe('number')
    await cleanup()
  })

  it('classe en plusieurs catégories avec une matrice de confusion', async () => {
    const { db, profile, cleanup } = await loadSample('demo_complet.csv')
    const r = await trainModels(db, profile, 'segment')
    expect(r.task).toBe('multiclass')
    expect(r.target.classes).toHaveLength(3)
    expect(r.models.find((m) => m.kind === r.best)!.score).toBeGreaterThan(0.8)
    expect(r.quality.type).toBe('heatmap')
    const out = predictOne(recentModel(r.id)!, { panier_moyen: 400, depenses_totales: 8000, nb_commandes: 20 })
    expect(out?.probabilities?.reduce((s, p) => s + p.p, 0)).toBeCloseTo(1, 2)
    expect(recentModel('inconnu')).toBeUndefined()
    await cleanup()
  })

  it('prévoit une série temporelle en comparant quatre méthodes', async () => {
    const { db, profile, cleanup } = await loadSample('demo_complet.csv')
    const f = await forecastSeries(db, profile, 'date', 'depenses_totales', { periods: 3 })
    expect(f.models.map((m) => m.kind)).toEqual(['naive', 'trend', 'holt', 'neural'])
    expect(f.table.rows).toHaveLength(3)
    expect(f.chart.data.columns).toEqual(['période', 'historique', 'prévision', 'borne basse', 'borne haute'])
    await expect(forecastSeries(db, profile, 'region', 'age')).rejects.toThrow(/dates/)
    await cleanup()
  })
})
