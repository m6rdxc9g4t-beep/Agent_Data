// Profil du jeu de données (types, complétude, statistiques) et score de qualité, calculés par DuckDB.
import { isNumericType, isTemporalType, quoteIdent, type DatasetDb } from './db.js'

export type Kind = 'numeric' | 'datetime' | 'boolean' | 'category' | 'text' | 'id' | 'constant'

export const KIND_LABELS: Record<Kind, string> = {
  numeric: 'Numérique',
  datetime: 'Date',
  boolean: 'Booléen',
  category: 'Catégorie',
  text: 'Texte',
  id: 'Identifiant',
  constant: 'Constante',
}

export interface ColumnProfile {
  name: string
  type: string
  kind: Kind
  missing: number
  completeness: number
  distinct: number
  min: string | number | null
  max: string | number | null
  mean: number | null
  median: number | null
  std: number | null
  top: string | null
  topCount: number | null
}

export interface QualityReport {
  score: number
  grade: string
  completeness: number
  duplicateRows: number
  constantColumns: string[]
  highMissing: { column: string; share: number }[]
  outliers: { column: string; share: number }[]
  numericAsText: string[]
  recommendations: string[]
}

export interface Profile {
  rows: number
  columns: ColumnProfile[]
  quality: QualityReport
}

function kindOf(type: string, distinct: number, rows: number, avgLen: number | null): Kind {
  if (distinct <= 1) return 'constant'
  if (type === 'BOOLEAN') return 'boolean'
  if (isTemporalType(type)) return 'datetime'
  if (isNumericType(type)) {
    if (distinct === 2) return 'boolean'
    if (/INT/.test(type) && distinct === rows && rows > 20) return 'id'
    return 'numeric'
  }
  if (rows > 20 && distinct / rows > 0.95) return (avgLen ?? 0) > 30 ? 'text' : 'id'
  if (distinct <= Math.max(30, Math.floor(0.05 * rows))) return 'category'
  return 'text'
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))

export async function computeProfile(db: DatasetDb): Promise<Profile> {
  const schema = await db.query('DESCRIBE data', 10_000)
  const cols = schema.rows.map((r) => ({ name: String(r[0]), type: String(r[1]) }))
  const rows = Number(await db.scalar<number>('SELECT count(*) FROM data'))

  // Une seule passe pour les agrégats de toutes les colonnes.
  const parts: string[] = []
  cols.forEach((c, i) => {
    const q = quoteIdent(c.name)
    parts.push(`count(${q}) AS n${i}`, `count(DISTINCT ${q}) AS d${i}`)
    if (isNumericType(c.type)) {
      parts.push(`min(${q})::DOUBLE AS mi${i}`, `max(${q})::DOUBLE AS ma${i}`, `avg(${q})::DOUBLE AS av${i}`,
        `median(${q})::DOUBLE AS me${i}`, `stddev_samp(${q})::DOUBLE AS sd${i}`,
        `quantile_cont(${q}, 0.25)::DOUBLE AS qa${i}`, `quantile_cont(${q}, 0.75)::DOUBLE AS qb${i}`)
    } else if (isTemporalType(c.type)) {
      parts.push(`min(${q})::VARCHAR AS mi${i}`, `max(${q})::VARCHAR AS ma${i}`)
    } else if (c.type === 'VARCHAR') {
      parts.push(`avg(length(${q}))::DOUBLE AS len${i}`,
        `avg(CASE WHEN TRY_CAST(replace(trim(${q}), ',', '.') AS DOUBLE) IS NOT NULL THEN 1.0 ELSE 0.0 END) FILTER (WHERE ${q} IS NOT NULL) AS nt${i}`)
    }
  })
  const agg = await db.query(`SELECT ${parts.join(', ')} FROM data`, 1)
  const a: Record<string, unknown> = {}
  agg.columns.forEach((c, i) => (a[c.name] = agg.rows[0]?.[i]))

  const profiles: ColumnProfile[] = []
  const outliers: QualityReport['outliers'] = []
  const numericAsText: string[] = []
  for (const [i, c] of cols.entries()) {
    const present = Number(a[`n${i}`] ?? 0)
    const distinct = Number(a[`d${i}`] ?? 0)
    const kind = kindOf(c.type, distinct, rows, num(a[`len${i}`]))
    const p: ColumnProfile = {
      name: c.name, type: c.type, kind,
      missing: rows - present,
      completeness: rows ? present / rows : 0,
      distinct,
      min: (a[`mi${i}`] as number | string | null) ?? null,
      max: (a[`ma${i}`] as number | string | null) ?? null,
      mean: num(a[`av${i}`]), median: num(a[`me${i}`]), std: num(a[`sd${i}`]),
      top: null, topCount: null,
    }
    if (kind !== 'numeric' && kind !== 'datetime' && present) {
      const q = quoteIdent(c.name)
      const t = await db.query(`SELECT ${q}::VARCHAR, count(*) AS n FROM data WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, 1)
      p.top = (t.rows[0]?.[0] as string) ?? null
      p.topCount = (t.rows[0]?.[1] as number) ?? null
    }
    profiles.push(p)

    if (kind === 'numeric' && present >= 10) {
      const q1 = num(a[`qa${i}`]), q3 = num(a[`qb${i}`])
      if (q1 !== null && q3 !== null && q3 > q1) {
        const iqr = q3 - q1, q = quoteIdent(c.name)
        const share = Number(await db.scalar(
          `SELECT avg(CASE WHEN ${q} < ${q1 - 1.5 * iqr} OR ${q} > ${q3 + 1.5 * iqr} THEN 1.0 ELSE 0.0 END) FROM data WHERE ${q} IS NOT NULL`))
        if (share > 0.05) outliers.push({ column: c.name, share })
      }
    }
    if (c.type === 'VARCHAR' && Number(a[`nt${i}`] ?? 0) > 0.9 && present > 0) numericAsText.push(c.name)
  }

  const distinctRows = Number(await db.scalar('SELECT count(*) FROM (SELECT DISTINCT * FROM data)'))
  const duplicateRows = rows - distinctRows
  const cells = rows * cols.length || 1
  const completeness = 1 - profiles.reduce((s, p) => s + p.missing, 0) / cells
  const constantColumns = profiles.filter((p) => p.kind === 'constant').map((p) => p.name)
  const highMissing = profiles.filter((p) => 1 - p.completeness > 0.2).map((p) => ({ column: p.name, share: 1 - p.completeness }))

  // Score : complétude (50), unicité des lignes (20), colonnes informatives (15), cohérence (15).
  let score = 50 * completeness
  score += 20 * (1 - Math.min(1, (duplicateRows / Math.max(1, rows)) * 5))
  score += 15 * (1 - constantColumns.length / Math.max(1, cols.length))
  score += 15 * (1 - Math.min(1, (numericAsText.length + 0.5 * outliers.length) / Math.max(1, cols.length)))
  score = Math.round(score)

  const pct = (x: number) => `${Math.round(x * 100)} %`
  const recommendations: string[] = []
  if (duplicateRows) recommendations.push(`Supprimer ou expliquer les ${duplicateRows} ligne(s) en double.`)
  for (const m of [...highMissing].sort((x, y) => y.share - x.share).slice(0, 5)) {
    recommendations.push(`\`${m.column}\` : ${pct(m.share)} de valeurs manquantes — imputer, compléter ou écarter.`)
  }
  for (const c of numericAsText.slice(0, 5)) recommendations.push(`\`${c}\` contient des nombres stockés en texte — convertir en numérique.`)
  for (const o of [...outliers].sort((x, y) => y.share - x.share).slice(0, 5)) {
    recommendations.push(`\`${o.column}\` : ${pct(o.share)} de valeurs atypiques (méthode IQR) — vérifier la saisie ou l'unité.`)
  }
  if (constantColumns.length) {
    recommendations.push(`Colonnes constantes, sans information : ${constantColumns.slice(0, 6).map((c) => `\`${c}\``).join(', ')}.`)
  }
  if (!recommendations.length) recommendations.push("Aucun problème majeur détecté : les données sont prêtes pour l'analyse.")

  const grade = score >= 90 ? 'Excellente' : score >= 75 ? 'Bonne' : score >= 55 ? 'Moyenne' : 'Faible'
  return {
    rows,
    columns: profiles,
    quality: { score, grade, completeness, duplicateRows, constantColumns, highMissing, outliers, numericAsText, recommendations },
  }
}

/** Résumé compact injecté dans le prompt système de l'agent. */
export function profileForPrompt(name: string, profile: Profile): string {
  const lines = [`Jeu de données « ${name} » : table \`data\`, ${profile.rows} lignes × ${profile.columns.length} colonnes.`, '', 'Colonnes :']
  for (const c of profile.columns.slice(0, 80)) {
    let detail = `${KIND_LABELS[c.kind].toLowerCase()}, ${c.distinct} valeurs distinctes`
    if (c.kind === 'numeric') detail += `, min ${fmt(c.min)}, médiane ${fmt(c.median)}, max ${fmt(c.max)}`
    else if (c.kind === 'datetime') detail += `, du ${c.min} au ${c.max}`
    else if (c.top) detail += `, la plus fréquente : « ${c.top} »`
    if (c.missing) detail += `, ${c.missing} manquante(s)`
    lines.push(`- "${c.name}" (${c.type}) — ${detail}`)
  }
  if (profile.columns.length > 80) lines.push(`… et ${profile.columns.length - 80} autres colonnes.`)
  return lines.join('\n')
}

function fmt(v: unknown): string {
  if (typeof v !== 'number') return String(v)
  return Math.abs(v) >= 1000 ? v.toFixed(0) : String(Number(v.toPrecision(4)))
}
