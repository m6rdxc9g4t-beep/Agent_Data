// Graphiques : exécution des spécifications de l'agent, graphiques automatiques et par colonne.
// Le rendu est fait par le navigateur (ECharts) à partir de la spécification et des données.
import { QueryError, quoteIdent, type DatasetDb } from './db.js'
import type { ColumnProfile, Profile } from './profile.js'
import type { ChartSpec } from './store.js'

export const CHART_TYPES = ['bar', 'horizontal_bar', 'line', 'area', 'scatter', 'pie', 'histogram', 'heatmap'] as const

export interface ChartRequest {
  type: string
  title: string
  sql: string
  x: string
  y?: string | string[]
  series?: string
  subtitle?: string
  stacked?: boolean
  bins?: number
}

const MAX_POINTS = 2000

function histogram(values: number[], bins: number): { columns: string[]; rows: unknown[][] } {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return { columns: ['intervalle', 'effectif'], rows: [] }
  let min = Infinity, max = -Infinity
  for (const x of v) { if (x < min) min = x; if (x > max) max = x }
  const n = Math.max(1, Math.min(60, bins))
  const width = max === min ? 1 : (max - min) / n
  const counts = new Array(n).fill(0)
  for (const x of v) counts[Math.min(n - 1, Math.floor((x - min) / width))]++
  const label = (a: number) => (Math.abs(a) >= 100 ? a.toFixed(0) : Number(a.toPrecision(3)).toString()).replace('.', ',')
  return {
    columns: ['intervalle', 'effectif'],
    rows: counts.map((c, i) => [`${label(min + i * width)} – ${label(min + (i + 1) * width)}`, c]),
  }
}

/** Exécute la requête d'un graphique demandé par l'agent et contrôle les colonnes. */
export async function buildChart(db: DatasetDb, req: ChartRequest): Promise<ChartSpec> {
  const type = (CHART_TYPES as readonly string[]).includes(req.type) ? (req.type as ChartSpec['type']) : 'bar'
  if (!req.sql) throw new QueryError('Paramètre « sql » manquant.')
  const result = await db.safeQuery(req.sql, MAX_POINTS)
  const names = result.columns.map((c) => c.name)
  const find = (name: string | undefined, role: string): string => {
    if (!name) throw new QueryError(`Paramètre « ${role} » manquant.`)
    const exact = names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === name.toLowerCase())
    if (!exact) throw new QueryError(`Colonne « ${name} » (${role}) absente du résultat. Colonnes : ${names.join(', ')}.`)
    return exact
  }
  const x = find(req.x, 'x')
  const yList = req.y === undefined ? [] : Array.isArray(req.y) ? req.y : [req.y]

  if (type === 'histogram') {
    const idx = names.indexOf(x)
    const values = result.rows.map((r) => Number(r[idx]))
    if (result.truncated) {
      // L'histogramme a besoin de toutes les valeurs : on relit la colonne sans la limite d'affichage.
      const all = await db.safeQuery(req.sql, 200_000)
      values.splice(0, values.length, ...all.rows.map((r) => Number(r[idx])))
    }
    return { type, title: req.title, subtitle: req.subtitle, x: 'intervalle', y: ['effectif'], data: histogram(values, req.bins ?? 20), xLabel: x, yLabel: 'Effectif' }
  }

  const y = (yList.length ? yList : names.filter((n) => n !== x && n !== req.series).slice(0, type === 'heatmap' ? 1 : 3)).map((n) => find(n, 'y'))
  if (!y.length) throw new QueryError('Aucune colonne de valeurs (y) pour le graphique.')
  const series = req.series ? find(req.series, 'series') : undefined
  const keep = [x, ...(series ? [series] : []), ...y]
  const idx = keep.map((n) => names.indexOf(n))
  return {
    type,
    title: req.title || `${y.join(', ')} par ${x}`,
    subtitle: req.subtitle,
    x,
    y,
    series,
    stacked: req.stacked,
    data: { columns: keep, rows: result.rows.map((r) => idx.map((i) => r[i])) },
  }
}

// --------------------------------------------------------------------------------------------- //
// Graphiques automatiques (onglet Exploration)
// --------------------------------------------------------------------------------------------- //
const MEASURES = [
  /(montant|d[ée]pense|vente|revenu|chiffre|^ca$|_ca$|total|amount|sales|revenue|profit|marge|margin|budget)/i,
  /(prix|price|co[uû]t|cost|quantit|qty|volume|valeur|value|nb_|nombre|count)/i,
]
const AVERAGE = /(^age$|_age$|ann[ée]e|year|mois|month|anciennet|note|satisf|taux|rate|ratio|score|pourcent|percent|^id|_id$|code|lat|lon|churn|temp)/i

export function pickMeasure(cols: ColumnProfile[]): { col: ColumnProfile | null; agg: 'sum' | 'avg' } {
  const numeric = cols.filter((c) => c.kind === 'numeric')
  if (!numeric.length) return { col: null, agg: 'sum' }
  for (const re of MEASURES) {
    const hit = numeric.find((c) => re.test(c.name) && !AVERAGE.test(c.name))
    if (hit) return { col: hit, agg: 'sum' }
  }
  const positive = numeric.find((c) => !AVERAGE.test(c.name) && typeof c.min === 'number' && c.min >= 0)
  return positive ? { col: positive, agg: 'sum' } : { col: numeric[0], agg: 'avg' }
}

export async function autoCharts(db: DatasetDb, profile: Profile): Promise<ChartSpec[]> {
  const cols = profile.columns
  const date = cols.find((c) => c.kind === 'datetime')
  const cats = cols.filter((c) => (c.kind === 'category' || c.kind === 'boolean') && c.distinct <= 20)
  const { col: measure, agg } = pickMeasure(cols)
  const aggLabel = agg === 'sum' ? 'Somme' : 'Moyenne'
  const charts: ChartSpec[] = []
  const run = async (req: ChartRequest) => {
    try {
      const spec = await buildChart(db, req)
      if (spec.data.rows.length > 1) charts.push(spec)
    } catch {
      /* graphique ignoré */
    }
  }

  if (date && measure) {
    const d = quoteIdent(date.name), m = quoteIdent(measure.name)
    await run({
      type: 'area', title: `Évolution de ${measure.name}`, subtitle: `${aggLabel} mensuelle`, x: 'mois', y: measure.name,
      sql: `SELECT strftime(date_trunc('month', ${d}), '%Y-%m') AS mois, round(${agg}(${m}), 2) AS ${m} FROM data WHERE ${d} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    })
  }
  if (cats[0] && measure) {
    const c = quoteIdent(cats[0].name), m = quoteIdent(measure.name)
    await run({
      type: 'horizontal_bar', title: `${measure.name} par ${cats[0].name}`, subtitle: `${aggLabel}, 10 premières modalités`, x: cats[0].name, y: measure.name,
      sql: `SELECT ${c}::VARCHAR AS ${c}, round(${agg}(${m}), 2) AS ${m} FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    })
  }
  const pieCat = cats[1] ?? cats[0]
  if (pieCat) {
    const c = quoteIdent(pieCat.name)
    await run({
      type: 'pie', title: `Répartition : ${pieCat.name}`, subtitle: `${profile.rows} lignes`, x: pieCat.name, y: 'lignes',
      sql: `SELECT coalesce(${c}::VARCHAR, '(vide)') AS ${c}, count(*) AS lignes FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    })
  }
  const other = cols.find((c) => c.kind === 'numeric' && c.name !== measure?.name) ?? measure
  if (other) {
    await run({
      type: 'histogram', title: `Distribution de ${other.name}`, subtitle: `Médiane : ${other.median ?? '—'}`, x: other.name,
      sql: `SELECT ${quoteIdent(other.name)} FROM data WHERE ${quoteIdent(other.name)} IS NOT NULL`,
    })
  }
  return charts
}

export async function columnChart(db: DatasetDb, col: ColumnProfile): Promise<ChartSpec | null> {
  const q = quoteIdent(col.name)
  try {
    if (col.kind === 'numeric') {
      return await buildChart(db, { type: 'histogram', title: `Distribution de ${col.name}`, x: col.name, sql: `SELECT ${q} FROM data WHERE ${q} IS NOT NULL`, bins: 30 })
    }
    if (col.kind === 'datetime') {
      return await buildChart(db, {
        type: 'bar', title: `Lignes par mois : ${col.name}`, x: 'mois', y: 'lignes',
        sql: `SELECT strftime(date_trunc('month', ${q}), '%Y-%m') AS mois, count(*) AS lignes FROM data WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      })
    }
    return await buildChart(db, {
      type: 'horizontal_bar', title: `Valeurs les plus fréquentes : ${col.name}`, x: 'valeur', y: 'lignes',
      sql: `SELECT left(${q}::VARCHAR, 40) AS valeur, count(*) AS lignes FROM data WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    })
  } catch {
    return null
  }
}
