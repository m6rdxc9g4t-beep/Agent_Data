// Préparation des données pour l'apprentissage : choix des variables, encodage, découpage.
//   - numériques : valeur manquante remplacée par la médiane, puis centrage-réduction ;
//   - catégories : indicatrices (20 modalités les plus fréquentes au plus, le reste dans « autre ») ;
//   - dates : année, mois, jour de la semaine et rang du jour.
// L'encodage est sérialisable : il sert aussi au simulateur de prédiction.
import { QueryError, quoteIdent, type DatasetDb } from '../db.js'
import type { ColumnProfile, Profile } from '../profile.js'

export type FeatureEncoding =
  | { name: string; kind: 'num'; median: number; mean: number; std: number }
  | { name: string; kind: 'cat'; levels: string[]; mode: string }
  | { name: string; kind: 'date'; median: number; parts: { mean: number; std: number }[] }

export interface TargetInfo {
  name: string
  task: 'regression' | 'binary' | 'multiclass'
  classes: string[]
}

export interface Prepared {
  target: TargetInfo
  encodings: FeatureEncoding[]
  columns: string[] // nom de chaque colonne encodée
  groups: number[][] // indices des colonnes encodées par variable d'origine
  X: number[][]
  y: number[]
  rawRows: Record<string, unknown>[]
}

export const MAX_ROWS = 20_000
const MAX_LEVELS = 20

export function targetCandidates(profile: Profile): ColumnProfile[] {
  return profile.columns.filter((c) => c.kind === 'numeric' || c.kind === 'boolean' || (c.kind === 'category' && c.distinct <= 10 && c.distinct >= 2))
}

export function featureCandidates(profile: Profile, target: string): ColumnProfile[] {
  return profile.columns.filter((c) => c.name !== target &&
    (c.kind === 'numeric' || c.kind === 'boolean' || c.kind === 'datetime' || (c.kind === 'category' && c.distinct <= 60)))
}

function col(profile: Profile, name: string): ColumnProfile {
  const c = profile.columns.find((p) => p.name === name)
  if (!c) throw new QueryError(`Colonne inconnue : « ${name} ».`)
  return c
}

const DAY = 86_400_000
function dateParts(v: unknown): number[] | null {
  if (v === null || v === undefined || v === '') return null
  const d = new Date(String(v).replace(' ', 'T') + (String(v).length <= 10 ? 'T00:00:00Z' : ''))
  if (Number.isNaN(d.getTime())) return null
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getTime() / DAY]
}

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const meanStd = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length)) || 1
  return { mean: m, std: sd }
}

/** Encode une ligne brute (objet colonne → valeur) avec l'encodage appris. */
export function encodeRow(encodings: FeatureEncoding[], row: Record<string, unknown>): number[] {
  const out: number[] = []
  for (const e of encodings) {
    const v = row[e.name]
    if (e.kind === 'num') {
      const n = v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? e.median : Number(v)
      out.push((n - e.mean) / e.std)
    } else if (e.kind === 'cat') {
      const s = v === null || v === undefined || v === '' ? e.mode : String(v)
      const known = e.levels.includes(s)
      for (const l of e.levels) out.push(l === s ? 1 : 0)
      out.push(known ? 0 : 1) // « autre »
    } else {
      const p = dateParts(v) ?? dateParts(new Date(e.median * DAY).toISOString().slice(0, 10))!
      p.forEach((x, i) => out.push((x - e.parts[i].mean) / e.parts[i].std))
    }
  }
  return out
}

export async function prepare(db: DatasetDb, profile: Profile, targetName: string, featureNames?: string[]): Promise<Prepared> {
  const t = col(profile, targetName)
  const allowed = featureCandidates(profile, t.name)
  const feats = (featureNames?.length ? featureNames.map((f) => col(profile, f)) : allowed)
    .filter((f) => f.name !== t.name && allowed.some((a) => a.name === f.name))
  if (!feats.length) throw new QueryError('Aucune variable explicative utilisable.')

  const isClass = t.kind === 'boolean' || t.kind === 'category'
  if (!isClass && t.kind !== 'numeric') throw new QueryError(`La cible « ${t.name} » doit être numérique ou une catégorie de 10 modalités au plus.`)

  const select = [`${quoteIdent(t.name)} AS __target`, ...feats.map((f) => quoteIdent(f.name))].join(', ')
  const res = await db.query(
    `SELECT ${select} FROM data WHERE ${quoteIdent(t.name)} IS NOT NULL USING SAMPLE reservoir(${MAX_ROWS} ROWS) REPEATABLE (42)`, MAX_ROWS)
  const rows = res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c.name, r[i]])))
  if (rows.length < 30) throw new QueryError('Il faut au moins 30 lignes avec une cible renseignée pour entraîner un modèle.')

  // Cible
  let target: TargetInfo
  let y: number[]
  if (isClass) {
    const classes = [...new Set(rows.map((r) => String(r.__target)))].sort()
    if (classes.length < 2) throw new QueryError('La cible ne contient qu’une seule valeur.')
    target = { name: t.name, task: classes.length === 2 ? 'binary' : 'multiclass', classes }
    y = rows.map((r) => classes.indexOf(String(r.__target)))
  } else {
    target = { name: t.name, task: 'regression', classes: [] }
    y = rows.map((r) => Number(r.__target))
  }

  // Encodage appris sur les données
  const encodings: FeatureEncoding[] = feats.map((f) => {
    const values = rows.map((r) => r[f.name])
    if (f.kind === 'datetime') {
      const parts = values.map(dateParts).filter((p): p is number[] => !!p)
      return { name: f.name, kind: 'date', median: median(parts.map((p) => p[3])), parts: [0, 1, 2, 3].map((i) => meanStd(parts.map((p) => p[i]))) }
    }
    if (f.kind === 'category') {
      const counts = new Map<string, number>()
      for (const v of values) if (v !== null && v !== undefined && v !== '') counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
      const levels = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LEVELS).map(([l]) => l)
      return { name: f.name, kind: 'cat', levels, mode: levels[0] ?? '' }
    }
    const nums = values.filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number)
    const med = median(nums)
    const filled = values.map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? med : Number(v)))
    return { name: f.name, kind: 'num', median: med, ...meanStd(filled) }
  })

  const columns: string[] = []
  const groups: number[][] = []
  for (const e of encodings) {
    const start = columns.length
    if (e.kind === 'num') columns.push(e.name)
    else if (e.kind === 'cat') columns.push(...e.levels.map((l) => `${e.name} = ${l}`), `${e.name} = autre`)
    else columns.push(`${e.name} (année)`, `${e.name} (mois)`, `${e.name} (jour de semaine)`, `${e.name} (date)`)
    groups.push(Array.from({ length: columns.length - start }, (_, i) => start + i))
  }
  const X = rows.map((r) => encodeRow(encodings, r))
  return { target, encodings, columns, groups, X, y, rawRows: rows }
}
