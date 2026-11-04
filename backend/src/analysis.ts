// Segmentation k-means proposée à l'agent comme outil. Les modèles prédictifs et les prévisions
// sont dans ml/ (train.ts, timeseries.ts).
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
