// Analyses statistiques proposées à l'agent comme outils : segmentation (k-means),
// modèle prédictif (régression linéaire ou logistique) et prévision temporelle.
import { QueryError, quoteIdent, type DatasetDb } from './db.js'
import type { ColumnProfile, Profile } from './profile.js'
import type { ChartSpec } from './store.js'

export interface AnalysisResult {
  summary: string
  table: { columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean }
  chart?: ChartSpec
}

const round = (x: number, d = 3) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null)

function rng(seed = 42) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function column(profile: Profile, name: string): ColumnProfile {
  const c = profile.columns.find((p) => p.name === name) ?? profile.columns.find((p) => p.name.toLowerCase() === name?.toLowerCase())
  if (!c) throw new QueryError(`Colonne inconnue : « ${name} ». Colonnes : ${profile.columns.map((p) => p.name).join(', ')}.`)
  return c
}

function standardize(X: number[][]): { Z: number[][]; mean: number[]; std: number[] } {
  const d = X[0]?.length ?? 0
  const mean = new Array(d).fill(0), std = new Array(d).fill(0)
  for (const r of X) r.forEach((v, j) => (mean[j] += v / X.length))
  for (const r of X) r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / X.length))
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1
  return { Z: X.map((r) => r.map((v, j) => (v - mean[j]) / std[j])), mean, std }
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)

// --------------------------------------------------------------------------------------------- //
// k-means
// --------------------------------------------------------------------------------------------- //
function kmeansFit(Z: number[][], k: number, rand: () => number): { labels: number[]; centers: number[][]; inertia: number } {
  const centers: number[][] = [Z[Math.floor(rand() * Z.length)]]
  while (centers.length < k) {
    const d = Z.map((p) => Math.min(...centers.map((c) => dist2(p, c))))
    const total = d.reduce((s, v) => s + v, 0)
    let r = rand() * total, i = 0
    while (i < d.length - 1 && (r -= d[i]) > 0) i++
    centers.push(Z[i])
  }
  let labels = new Array(Z.length).fill(0)
  for (let iter = 0; iter < 60; iter++) {
    const next = Z.map((p) => centers.reduce((best, c, j) => (dist2(p, c) < dist2(p, centers[best]) ? j : best), 0))
    const moved = next.some((l, i) => l !== labels[i])
    labels = next
    for (let j = 0; j < k; j++) {
      const members = Z.filter((_, i) => labels[i] === j)
      if (members.length) centers[j] = members[0].map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length)
    }
    if (!moved && iter > 0) break
  }
  const inertia = Z.reduce((s, p, i) => s + dist2(p, centers[labels[i]]), 0)
  return { labels, centers, inertia }
}

function silhouette(Z: number[][], labels: number[], k: number): number {
  const n = Math.min(Z.length, 1500)
  let total = 0
  for (let i = 0; i < n; i++) {
    const sums = new Array(k).fill(0), counts = new Array(k).fill(0)
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      sums[labels[j]] += Math.sqrt(dist2(Z[i], Z[j]))
      counts[labels[j]]++
    }
    const a = counts[labels[i]] ? sums[labels[i]] / counts[labels[i]] : 0
    const b = Math.min(...sums.map((s, c) => (c === labels[i] || !counts[c] ? Infinity : s / counts[c])))
    total += b === Infinity ? 0 : (b - a) / Math.max(a, b)
  }
  return total / n
}

export async function kmeans(db: DatasetDb, profile: Profile, columns: string[] | undefined, k?: number): Promise<AnalysisResult> {
  const cols = (columns?.length ? columns.map((c) => column(profile, c)) : profile.columns.filter((c) => c.kind === 'numeric'))
    .filter((c) => c.kind === 'numeric' || c.kind === 'boolean')
  if (cols.length < 1) throw new QueryError('Aucune colonne numérique à segmenter.')
  const list = cols.map((c) => `${quoteIdent(c.name)}::DOUBLE`).join(', ')
  const where = cols.map((c) => `${quoteIdent(c.name)} IS NOT NULL`).join(' AND ')
  const res = await db.query(`SELECT ${list} FROM data WHERE ${where} USING SAMPLE reservoir(20000 ROWS) REPEATABLE (42)`, 20_000)
  const X = res.rows.map((r) => r.map(Number))
  if (X.length < 10) throw new QueryError('Pas assez de lignes complètes pour une segmentation.')
  const { Z } = standardize(X)
  const rand = rng()
  let best = { k: k ?? 3, fit: kmeansFit(Z, k ?? 3, rand), sil: -1 }
  if (!k) {
    for (let kk = 2; kk <= Math.min(6, X.length - 1); kk++) {
      const fit = kmeansFit(Z, kk, rand)
      const sil = silhouette(Z, fit.labels, kk)
      if (sil > best.sil) best = { k: kk, fit, sil }
    }
  } else {
    best.sil = silhouette(Z, best.fit.labels, best.k)
  }
  const rows: unknown[][] = []
  for (let j = 0; j < best.k; j++) {
    const members = X.filter((_, i) => best.fit.labels[i] === j)
    if (!members.length) continue
    const means = cols.map((_, d) => round(members.reduce((s, m) => s + m[d], 0) / members.length, 2))
    rows.push([`Segment ${j + 1}`, members.length, round((members.length / X.length) * 100, 1), ...means])
  }
  rows.sort((a, b) => (b[1] as number) - (a[1] as number))
  return {
    summary: `k-means sur ${X.length} lignes, ${cols.length} variable(s) normalisée(s) : ${best.k} segments, silhouette ${round(best.sil, 2)} ` +
      `(${best.sil > 0.5 ? 'segments bien séparés' : best.sil > 0.25 ? 'séparation correcte' : 'segments peu distincts'}).`,
    table: {
      columns: [{ name: 'segment', type: 'VARCHAR' }, { name: 'lignes', type: 'BIGINT' }, { name: 'part_%', type: 'DOUBLE' },
        ...cols.map((c) => ({ name: `moyenne_${c.name}`, type: 'DOUBLE' }))],
      rows,
      truncated: false,
    },
  }
}

// --------------------------------------------------------------------------------------------- //
// Modèle prédictif
// --------------------------------------------------------------------------------------------- //
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    const piv = M[c][c] || 1e-12
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / piv
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12))
}

function ols(X: number[][], y: number[], ridge = 1e-3): number[] {
  const d = X[0].length
  const A = Array.from({ length: d }, () => new Array(d).fill(0))
  const b = new Array(d).fill(0)
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i]
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k]
    }
  }
  for (let j = 1; j < d; j++) A[j][j] += ridge * X.length
  return solve(A, b)
}

function logistic(X: number[][], y: number[]): number[] {
  const d = X[0].length
  let w = new Array(d).fill(0)
  for (let it = 0; it < 400; it++) {
    const g = new Array(d).fill(0)
    for (let i = 0; i < X.length; i++) {
      const p = 1 / (1 + Math.exp(-X[i].reduce((s, v, j) => s + v * w[j], 0)))
      for (let j = 0; j < d; j++) g[j] += (p - y[i]) * X[i][j]
    }
    w = w.map((v, j) => v - (0.5 * g[j]) / X.length - (j ? 1e-3 * v : 0))
  }
  return w
}

export async function predictiveModel(db: DatasetDb, profile: Profile, target: string, features?: string[]): Promise<AnalysisResult> {
  const t = column(profile, target)
  const classification = t.distinct === 2
  if (!classification && t.kind !== 'numeric') throw new QueryError(`La cible « ${t.name} » doit être numérique ou binaire (2 valeurs).`)
  const candidates = features?.length ? features.map((f) => column(profile, f)) : profile.columns
  const feats = candidates.filter((c) => c.name !== t.name &&
    (c.kind === 'numeric' || c.kind === 'boolean' || (c.kind === 'category' && c.distinct <= 12)))
  if (!feats.length) throw new QueryError('Aucune variable explicative utilisable (numérique ou catégorie de 12 modalités au plus).')

  const select = [quoteIdent(t.name) + '::VARCHAR', ...feats.map((f) => (f.kind === 'category' ? `${quoteIdent(f.name)}::VARCHAR` : `${quoteIdent(f.name)}::DOUBLE`))]
  const where = [t, ...feats].map((c) => `${quoteIdent(c.name)} IS NOT NULL`).join(' AND ')
  const res = await db.query(`SELECT ${select.join(', ')} FROM data WHERE ${where} USING SAMPLE reservoir(50000 ROWS) REPEATABLE (42)`, 50_000)
  if (res.rows.length < 20) throw new QueryError('Pas assez de lignes complètes pour entraîner un modèle.')

  // Encodage : numériques tels quels, catégories en indicatrices (modalité la plus fréquente en référence).
  const names: string[] = []
  const encoders: ((row: unknown[]) => number[])[] = []
  feats.forEach((f, k) => {
    const col = k + 1
    if (f.kind === 'category') {
      const counts = new Map<string, number>()
      for (const r of res.rows) counts.set(String(r[col]), (counts.get(String(r[col])) ?? 0) + 1)
      const levels = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(1)
      levels.forEach((l) => names.push(`${f.name} = ${l}`))
      encoders.push((r) => levels.map((l) => (String(r[col]) === l ? 1 : 0)))
    } else {
      names.push(f.name)
      encoders.push((r) => [Number(r[col])])
    }
  })
  const classes = classification ? [...new Set(res.rows.map((r) => String(r[0])))].sort() : []
  const Xraw = res.rows.map((r) => encoders.flatMap((e) => e(r)))
  const y = res.rows.map((r) => (classification ? (String(r[0]) === classes[1] ? 1 : 0) : Number(r[0])))
  const { Z } = standardize(Xraw)
  const X = Z.map((r) => [1, ...r])

  const order = X.map((_, i) => i)
  const rand = rng(7)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const cut = Math.floor(order.length * 0.8)
  const train = order.slice(0, cut), test = order.slice(cut)
  const Xtr = train.map((i) => X[i]), ytr = train.map((i) => y[i])
  const w = classification ? logistic(Xtr, ytr) : ols(Xtr, ytr)
  const predict = (x: number[]) => {
    const s = x.reduce((acc, v, j) => acc + v * w[j], 0)
    return classification ? 1 / (1 + Math.exp(-s)) : s
  }

  const drivers = names.map((n, j) => ({ n, w: w[j + 1] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  let summary: string
  const metricsRows: unknown[][] = []
  if (classification) {
    let tp = 0, fp = 0, fn = 0, ok = 0
    for (const i of test) {
      const p = predict(X[i]) >= 0.5 ? 1 : 0
      if (p === y[i]) ok++
      if (p && y[i]) tp++
      if (p && !y[i]) fp++
      if (!p && y[i]) fn++
    }
    const acc = ok / test.length
    const base = Math.max(...[0, 1].map((c) => test.filter((i) => y[i] === c).length)) / test.length
    const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0
    metricsRows.push(['accuracy (test)', round(acc)], ['baseline (classe majoritaire)', round(base)], [`précision (classe ${classes[1]})`, round(prec)], ['rappel', round(rec)], ['F1', round(f1)])
    summary = `Régression logistique sur ${train.length} lignes (test : ${test.length}) pour prédire « ${t.name} » = ${classes[1]}. ` +
      `Accuracy ${round(acc * 100, 1)} % contre ${round(base * 100, 1)} % pour la baseline ; F1 ${round(f1, 2)}.`
  } else {
    const mean = ytr.reduce((s, v) => s + v, 0) / ytr.length
    let sse = 0, sst = 0, mae = 0, maeBase = 0
    for (const i of test) {
      const p = predict(X[i])
      sse += (y[i] - p) ** 2
      sst += (y[i] - mean) ** 2
      mae += Math.abs(y[i] - p) / test.length
      maeBase += Math.abs(y[i] - mean) / test.length
    }
    const r2 = sst ? 1 - sse / sst : 0
    metricsRows.push(['R² (test)', round(r2)], ['MAE (test)', round(mae, 2)], ['MAE baseline (moyenne)', round(maeBase, 2)])
    summary = `Régression linéaire sur ${train.length} lignes (test : ${test.length}) pour prédire « ${t.name} ». ` +
      `R² ${round(r2, 2)}, MAE ${round(mae, 2)} contre ${round(maeBase, 2)} pour la baseline.`
  }
  const rows = [
    ...metricsRows.map(([k, v]) => ['métrique', k, v]),
    ...drivers.slice(0, 15).map((d) => ['facteur', d.n, round(d.w, 4)]),
  ]
  return {
    summary: `${summary} Coefficients sur variables normalisées : leur valeur absolue mesure l'influence, le signe le sens.`,
    table: { columns: [{ name: 'type', type: 'VARCHAR' }, { name: 'élément', type: 'VARCHAR' }, { name: 'valeur', type: 'DOUBLE' }], rows, truncated: drivers.length > 15 },
    chart: {
      type: 'horizontal_bar', title: `Facteurs d'influence sur ${t.name}`, subtitle: 'Coefficients normalisés',
      x: 'facteur', y: ['coefficient'],
      data: { columns: ['facteur', 'coefficient'], rows: drivers.slice(0, 10).reverse().map((d) => [d.n, round(d.w, 4)]) },
    },
  }
}

// --------------------------------------------------------------------------------------------- //
// Prévision
// --------------------------------------------------------------------------------------------- //
export async function forecast(
  db: DatasetDb, profile: Profile, dateColumn: string, valueColumn: string,
  opts: { agg?: string; periods?: number; grain?: string } = {},
): Promise<AnalysisResult> {
  const d = column(profile, dateColumn), v = column(profile, valueColumn)
  if (d.kind !== 'datetime') throw new QueryError(`« ${d.name} » n'est pas une colonne de dates.`)
  if (v.kind !== 'numeric' && v.kind !== 'boolean') throw new QueryError(`« ${v.name} » n'est pas numérique.`)
  const agg = ['sum', 'avg', 'count', 'median', 'max', 'min'].includes(opts.agg ?? '') ? opts.agg! : 'sum'
  const grain = ['day', 'week', 'month', 'quarter', 'year'].includes(opts.grain ?? '') ? opts.grain! : 'month'
  const periods = Math.max(1, Math.min(24, opts.periods ?? 6))
  const res = await db.query(
    `SELECT date_trunc('${grain}', ${quoteIdent(d.name)})::DATE AS p, ${agg}(${quoteIdent(v.name)})::DOUBLE AS v ` +
    `FROM data WHERE ${quoteIdent(d.name)} IS NOT NULL GROUP BY 1 ORDER BY 1`, 5000)
  const pts = res.rows.map((r) => ({ p: String(r[0]), v: Number(r[1]) })).filter((x) => Number.isFinite(x.v))
  if (pts.length < 4) throw new QueryError('Il faut au moins 4 périodes pour une prévision.')

  // Tendance linéaire + saisonnalité (écart moyen par position dans le cycle) si l'historique couvre 2 cycles.
  const n = pts.length
  const xs = pts.map((_, i) => i), ys = pts.map((x) => x.v)
  const mx = (n - 1) / 2, my = ys.reduce((s, v) => s + v, 0) / n
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  const intercept = my - slope * mx
  const cycle = grain === 'month' ? 12 : grain === 'quarter' ? 4 : grain === 'week' ? 52 : 0
  const seasonal = new Array(cycle || 1).fill(0)
  const useSeason = cycle > 0 && n >= 2 * cycle
  if (useSeason) {
    const counts = new Array(cycle).fill(0)
    ys.forEach((y, i) => { seasonal[i % cycle] += y - (intercept + slope * i); counts[i % cycle]++ })
    for (let c = 0; c < cycle; c++) seasonal[c] /= counts[c] || 1
  }
  const fit = (i: number) => intercept + slope * i + (useSeason ? seasonal[i % cycle] : 0)
  const resid = ys.map((y, i) => y - fit(i))
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2))
  const mape = ys.reduce((s, y, i) => s + (y ? Math.abs(resid[i] / y) : 0), 0) / n

  const last = new Date(pts[n - 1].p + 'T00:00:00Z')
  const step = (k: number) => {
    const t = new Date(last)
    if (grain === 'day') t.setUTCDate(t.getUTCDate() + k)
    else if (grain === 'week') t.setUTCDate(t.getUTCDate() + 7 * k)
    else if (grain === 'month') t.setUTCMonth(t.getUTCMonth() + k)
    else if (grain === 'quarter') t.setUTCMonth(t.getUTCMonth() + 3 * k)
    else t.setUTCFullYear(t.getUTCFullYear() + k)
    return t.toISOString().slice(0, 10)
  }
  const future = Array.from({ length: periods }, (_, k) => ({ p: step(k + 1), v: fit(n + k) }))
  const label = (p: string) => (grain === 'month' ? p.slice(0, 7) : grain === 'year' ? p.slice(0, 4) : p)
  const chartRows: unknown[][] = [
    ...pts.map((x) => [label(x.p), round(x.v, 2), null]),
    ...future.map((x, k) => [label(x.p), k === 0 ? null : null, round(x.v, 2)]),
  ]
  chartRows[n - 1][2] = round(pts[n - 1].v, 2) // raccorde les deux courbes
  return {
    summary: `Prévision ${grain === 'month' ? 'mensuelle' : `par ${grain}`} de ${agg}(${v.name}) sur ${periods} période(s), ` +
      `tendance linéaire${useSeason ? ' + saisonnalité' : ''} ajustée sur ${n} périodes. Pente : ${round(slope, 2)} par période, ` +
      `erreur moyenne d'ajustement ${round(mape * 100, 1)} %, intervalle indicatif ± ${round(1.96 * sigma, 2)}.`,
    table: {
      columns: [{ name: 'période', type: 'VARCHAR' }, { name: 'prévision', type: 'DOUBLE' }, { name: 'borne_basse', type: 'DOUBLE' }, { name: 'borne_haute', type: 'DOUBLE' }],
      rows: future.map((x) => [label(x.p), round(x.v, 2), round(x.v - 1.96 * sigma, 2), round(x.v + 1.96 * sigma, 2)]),
      truncated: false,
    },
    chart: {
      type: 'line', title: `Prévision de ${v.name}`, subtitle: `${agg} par période · ${periods} période(s) projetée(s)`,
      x: 'période', y: ['historique', 'prévision'], data: { columns: ['période', 'historique', 'prévision'], rows: chartRows },
    },
  }
}
