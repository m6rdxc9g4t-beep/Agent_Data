// Prévision de séries temporelles : comparaison de modèles sur les dernières périodes, puis projection.
//   - naïf (dernière valeur ou même période du cycle précédent) : la référence à battre ;
//   - tendance linéaire + saisonnalité ;
//   - lissage exponentiel de Holt-Winters (niveau, tendance, saisonnalité additive) ;
//   - réseau de neurones autorégressif (apprend la valeur suivante à partir des dernières périodes).
import { QueryError, quoteIdent, type DatasetDb } from '../db.js'
import type { Profile } from '../profile.js'
import type { ChartSpec } from '../store.js'
import { predictMlp, trainMlp } from './mlp.js'

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year'
export type TsKind = 'naive' | 'trend' | 'holt' | 'neural'

export const TS_LABELS: Record<TsKind, string> = {
  naive: 'Référence naïve',
  trend: 'Tendance + saisonnalité',
  holt: 'Lissage de Holt-Winters',
  neural: 'Réseau de neurones autorégressif',
}

const TS_HINTS: Record<TsKind, string> = {
  naive: 'Répète la dernière valeur, ou celle de la même période du cycle précédent.',
  trend: 'Droite de tendance et écart moyen de chaque période du cycle.',
  holt: 'Moyenne pondérée qui suit niveau, pente et saisonnalité ; les dernières périodes comptent davantage.',
  neural: 'Apprentissage profond : le réseau apprend la période suivante à partir des précédentes.',
}

export interface TsModelResult { kind: TsKind; label: string; hint: string; mae: number; mape: number | null; detail: string }

export interface ForecastResult {
  date: string
  value: string
  agg: string
  grain: Grain
  periods: number
  history: number
  models: TsModelResult[]
  best: TsKind
  chart: ChartSpec
  table: { columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean }
  summary: string
}

type Forecaster = (y: number[], h: number) => number[]

const cycleOf = (g: Grain) => (g === 'month' ? 12 : g === 'quarter' ? 4 : g === 'week' ? 52 : g === 'day' ? 7 : 0)
const r = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : 0)

function naive(m: number): Forecaster {
  return (y, h) => Array.from({ length: h }, (_, i) => (m && y.length >= m ? y[y.length - m + (i % m)] : y[y.length - 1]))
}

function trendSeason(m: number): Forecaster {
  return (y, h) => {
    const n = y.length, mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n
    const den = y.reduce((s, _, i) => s + (i - mx) ** 2, 0) || 1
    const slope = y.reduce((s, v, i) => s + (i - mx) * (v - my), 0) / den
    const icpt = my - slope * mx
    const season = new Array(m || 1).fill(0)
    if (m && n >= 2 * m) {
      const cnt = new Array(m).fill(0)
      y.forEach((v, i) => { season[i % m] += v - (icpt + slope * i); cnt[i % m]++ })
      for (let k = 0; k < m; k++) season[k] /= cnt[k] || 1
    }
    return Array.from({ length: h }, (_, i) => icpt + slope * (n + i) + (m && n >= 2 * m ? season[(n + i) % m] : 0))
  }
}

function holtFit(y: number[], m: number, a: number, b: number, g: number) {
  const seasonal = m > 0 && y.length >= 2 * m
  let level = y[0], trend = y.length > 1 ? y[1] - y[0] : 0
  const s = new Array(seasonal ? m : 1).fill(0)
  if (seasonal) {
    const avg = y.slice(0, m).reduce((p, c) => p + c, 0) / m
    for (let k = 0; k < m; k++) s[k] = y[k] - avg
    level = avg
    trend = (y.slice(m, 2 * m).reduce((p, c) => p + c, 0) / m - avg) / m
  }
  let sse = 0
  for (let t = 1; t < y.length; t++) {
    const si = seasonal ? s[t % m] : 0
    const pred = level + trend + si
    sse += (y[t] - pred) ** 2
    const prevLevel = level
    level = a * (y[t] - si) + (1 - a) * (level + trend)
    trend = b * (level - prevLevel) + (1 - b) * trend
    if (seasonal) s[t % m] = g * (y[t] - level) + (1 - g) * si
  }
  return { level, trend, s, seasonal, sse }
}

function holtWinters(m: number): Forecaster {
  return (y, h) => {
    let best = { sse: Infinity } as ReturnType<typeof holtFit>
    const grid = [0.1, 0.3, 0.5, 0.7, 0.9]
    for (const a of grid) for (const b of [0.01, 0.1, 0.3]) for (const g of m ? [0.05, 0.2, 0.5] : [0]) {
      const fit = holtFit(y, m, a, b, g)
      if (fit.sse < best.sse) best = fit
    }
    const n = y.length
    return Array.from({ length: h }, (_, i) => best.level + (i + 1) * best.trend + (best.seasonal ? best.s[(n + i) % m] : 0))
  }
}

function neural(m: number): Forecaster {
  return (y, h) => {
    const lags = Math.max(3, Math.min(m || 6, Math.floor(y.length / 3)))
    const mean = y.reduce((a, b) => a + b, 0) / y.length
    const std = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / y.length) || 1
    const z = y.map((v) => (v - mean) / std)
    const X: number[][] = [], t: number[] = []
    for (let i = lags; i < z.length; i++) { X.push([...z.slice(i - lags, i), i / z.length]); t.push(z[i]) }
    if (X.length < 6) return trendSeason(m)(y, h)
    const nv = Math.max(2, Math.floor(X.length * 0.15))
    const model = trainMlp(X.slice(0, -nv), t.slice(0, -nv), X.slice(-nv), t.slice(-nv), 'regression', 1,
      { hidden: [16, 8], epochs: 400, batch: 8, lr: 0.005, l2: 1e-3, patience: 40, seed: 11, timeBudgetMs: 6000 })
    const hist = [...z], out: number[] = []
    for (let i = 0; i < h; i++) {
      const p = predictMlp(model, [[...hist.slice(-lags), hist.length / z.length]])[0][0]
      hist.push(p)
      out.push(p * std + mean)
    }
    return out
  }
}

export async function forecastSeries(
  db: DatasetDb, profile: Profile, dateName: string, valueName: string, opts: { agg?: string; grain?: string; periods?: number } = {},
): Promise<ForecastResult> {
  const d = profile.columns.find((c) => c.name === dateName)
  const v = profile.columns.find((c) => c.name === valueName)
  if (!d || d.kind !== 'datetime') throw new QueryError(`« ${dateName} » n'est pas une colonne de dates.`)
  if (!v || (v.kind !== 'numeric' && v.kind !== 'boolean')) throw new QueryError(`« ${valueName} » n'est pas une colonne numérique.`)
  const agg = ['sum', 'avg', 'count', 'median', 'max', 'min'].includes(opts.agg ?? '') ? opts.agg! : 'sum'
  const grain = (['day', 'week', 'month', 'quarter', 'year'].includes(opts.grain ?? '') ? opts.grain : 'month') as Grain
  const periods = Math.max(1, Math.min(36, opts.periods ?? 6))
  const res = await db.query(
    `SELECT date_trunc('${grain}', ${quoteIdent(d.name)})::DATE AS p, ${agg}(${quoteIdent(v.name)})::DOUBLE AS v ` +
    `FROM data WHERE ${quoteIdent(d.name)} IS NOT NULL GROUP BY 1 ORDER BY 1`, 10_000)
  const pts = res.rows.map((row) => ({ p: String(row[0]), v: Number(row[1]) })).filter((x) => Number.isFinite(x.v))
  if (pts.length < 6) throw new QueryError('Il faut au moins 6 périodes pour comparer des modèles de prévision.')

  const m = cycleOf(grain) && pts.length >= 2 * cycleOf(grain) ? cycleOf(grain) : 0
  const y = pts.map((x) => x.v)
  const hold = Math.max(2, Math.min(periods, Math.floor(y.length * 0.2)))
  const train = y.slice(0, -hold), test = y.slice(-hold)
  const makers: Record<TsKind, Forecaster> = { naive: naive(m), trend: trendSeason(m), holt: holtWinters(m), neural: neural(m) }

  const models: TsModelResult[] = (Object.keys(makers) as TsKind[]).map((kind) => {
    const f = makers[kind](train, hold)
    const mae = test.reduce((s, val, i) => s + Math.abs(val - f[i]), 0) / hold
    const nz = test.filter((val) => val !== 0)
    const mape = nz.length === test.length ? test.reduce((s, val, i) => s + Math.abs((val - f[i]) / val), 0) / hold : null
    return {
      kind, label: TS_LABELS[kind], hint: TS_HINTS[kind], mae: r(mae), mape: mape === null ? null : r(mape * 100, 1),
      detail: kind === 'naive' ? (m ? `cycle de ${m} périodes` : 'dernière valeur') : '',
    }
  })
  const best = [...models].filter((x) => x.kind !== 'naive').sort((a, b) => a.mae - b.mae)[0]

  // Projection avec le meilleur modèle réentraîné sur tout l'historique ; intervalle à partir des erreurs de test.
  const forecast = makers[best.kind](y, periods)
  const backtest = makers[best.kind](train, hold)
  const sigma = Math.sqrt(test.reduce((s, val, i) => s + (val - backtest[i]) ** 2, 0) / hold)

  const last = new Date(pts.at(-1)!.p + 'T00:00:00Z')
  const step = (k: number) => {
    const t = new Date(last)
    if (grain === 'day') t.setUTCDate(t.getUTCDate() + k)
    else if (grain === 'week') t.setUTCDate(t.getUTCDate() + 7 * k)
    else if (grain === 'month') t.setUTCMonth(t.getUTCMonth() + k)
    else if (grain === 'quarter') t.setUTCMonth(t.getUTCMonth() + 3 * k)
    else t.setUTCFullYear(t.getUTCFullYear() + k)
    return t.toISOString().slice(0, 10)
  }
  const label = (p: string) => (grain === 'month' ? p.slice(0, 7) : grain === 'year' ? p.slice(0, 4) : p)
  const future = forecast.map((val, i) => ({ p: step(i + 1), v: val }))
  const rows: unknown[][] = [
    ...pts.map((x) => [label(x.p), r(x.v), null, null, null]),
    ...future.map((x, i) => [label(x.p), null, r(x.v), r(x.v - 1.96 * sigma * Math.sqrt(1 + i * 0.15)), r(x.v + 1.96 * sigma * Math.sqrt(1 + i * 0.15))]),
  ]
  rows[pts.length - 1][2] = r(pts.at(-1)!.v) // raccorde la prévision à l'historique
  const aggLabel: Record<string, string> = { sum: 'somme', avg: 'moyenne', count: 'nombre', median: 'médiane', max: 'maximum', min: 'minimum' }
  const grainLabel: Record<Grain, string> = { day: 'jour', week: 'semaine', month: 'mois', quarter: 'trimestre', year: 'année' }

  const naiveMae = models.find((x) => x.kind === 'naive')!.mae
  const gain = naiveMae ? Math.round((1 - best.mae / naiveMae) * 100) : 0
  return {
    date: d.name, value: v.name, agg, grain, periods, history: pts.length, models, best: best.kind,
    chart: {
      type: 'line', title: `Prévision de ${v.name}`,
      subtitle: `${aggLabel[agg]} par ${grainLabel[grain]} · ${TS_LABELS[best.kind]} · zone indicative à 95 %`,
      x: 'période', y: ['historique', 'prévision', 'borne basse', 'borne haute'],
      data: { columns: ['période', 'historique', 'prévision', 'borne basse', 'borne haute'], rows },
    },
    table: {
      columns: [{ name: 'période', type: 'VARCHAR' }, { name: 'prévision', type: 'DOUBLE' }, { name: 'borne basse', type: 'DOUBLE' }, { name: 'borne haute', type: 'DOUBLE' }],
      rows: future.map((x, i) => [label(x.p), r(x.v), r(x.v - 1.96 * sigma * Math.sqrt(1 + i * 0.15)), r(x.v + 1.96 * sigma * Math.sqrt(1 + i * 0.15))]),
      truncated: false,
    },
    summary: `${TS_LABELS[best.kind]} retenu (erreur moyenne ${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(best.mae)} sur les ${hold} dernières périodes, ` +
      `${gain >= 0 ? `${gain} % de mieux` : `${-gain} % de moins bien`} que la référence naïve). ` +
      `Prévision sur ${periods} ${grainLabel[grain]}${periods > 1 && grain !== 'month' ? 's' : ''} à partir de ${pts.length} périodes d'historique.`,
  }
}
