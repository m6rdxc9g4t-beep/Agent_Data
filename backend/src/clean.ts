// Nettoyage appliqué : à partir du profil, propose des étapes (doublons, espaces, conversions, colonnes vides,
// valeurs manquantes, valeurs atypiques) et crée une NOUVELLE version du jeu de données ; l'original est conservé.
import { rm } from 'node:fs/promises'

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

import { isNumericType, quoteIdent, quoteString, type DatasetDb } from './db.js'
import { importFile } from './importer.js'
import type { Profile } from './profile.js'
import type { DatasetMeta, Store } from './store.js'

export type CleanStepKind = 'dedupe' | 'trim' | 'convert' | 'drop_columns' | 'fill_missing' | 'cap_outliers'

export interface CleanStep {
  kind: CleanStepKind
  /** Colonnes concernées (vide pour dedupe). */
  columns: string[]
}

export interface PlannedStep extends CleanStep {
  title: string
  detail: string
  /** Cochée par défaut : sans risque de déformer les données. */
  recommended: boolean
  /** Détail par colonne affiché à côté de chaque case. */
  columnNotes: Record<string, string>
}

const pct = (x: number) => `${Math.round(x * 100)} %`

/** Étapes proposées pour ce jeu, d'après le profil et quelques comptages. */
export async function planCleaning(db: DatasetDb, p: Profile): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = []
  const q = p.quality

  const texts = p.columns.filter((c) => c.type === 'VARCHAR')
  if (texts.length) {
    const parts = texts.map((c, i) => `count(*) FILTER (WHERE ${quoteIdent(c.name)} <> trim(${quoteIdent(c.name)}) OR trim(${quoteIdent(c.name)}) = '') AS t${i}`)
    const r = await db.query(`SELECT ${parts.join(', ')} FROM data`, 1)
    const notes: Record<string, string> = {}
    texts.forEach((c, i) => { const n = Number(r.rows[0]?.[i] ?? 0); if (n) notes[c.name] = `${n} cellule(s)` })
    const cols = Object.keys(notes)
    if (cols.length) {
      steps.push({ kind: 'trim', columns: cols, columnNotes: notes, recommended: true, title: 'Nettoyer les espaces',
        detail: 'Retire les espaces en début et fin de texte ; une cellule vide devient une valeur manquante.' })
    }
  }

  if (q.numericAsText.length) {
    steps.push({ kind: 'convert', columns: q.numericAsText, columnNotes: {}, recommended: true, title: 'Convertir en nombres',
      detail: 'Colonnes de nombres stockés en texte (virgule décimale acceptée) : elles deviennent numériques pour les calculs.' })
  }

  const empty = p.columns.filter((c) => c.kind === 'constant' || c.completeness < 0.4)
  if (empty.length) {
    const notes: Record<string, string> = {}
    for (const c of empty) notes[c.name] = c.kind === 'constant' ? (c.completeness === 0 ? 'vide' : 'constante') : `${pct(1 - c.completeness)} manquantes`
    steps.push({ kind: 'drop_columns', columns: empty.map((c) => c.name), columnNotes: notes,
      recommended: empty.every((c) => c.kind === 'constant'), title: 'Retirer les colonnes sans information',
      detail: 'Colonnes constantes ou majoritairement vides : elles n’apportent rien à l’analyse.' })
  }

  if (q.duplicateRows) {
    steps.push({ kind: 'dedupe', columns: [], columnNotes: {}, recommended: true, title: 'Supprimer les doublons',
      detail: `${q.duplicateRows} ligne(s) strictement identique(s) à une autre : une seule est gardée.` })
  }

  const missing = p.columns.filter((c) => c.missing > 0 && c.completeness >= 0.4 && ['numeric', 'category', 'boolean'].includes(c.kind))
  if (missing.length) {
    const notes: Record<string, string> = {}
    for (const c of missing) notes[c.name] = `${c.missing} manquante(s) → ${c.kind === 'numeric' ? `médiane` : `« ${c.top ?? '?'} »`}`
    steps.push({ kind: 'fill_missing', columns: missing.map((c) => c.name), columnNotes: notes, recommended: false,
      title: 'Compléter les valeurs manquantes',
      detail: 'Remplace les vides par la médiane (nombres) ou la valeur la plus fréquente (catégories). Pratique pour la modélisation, mais modifie les données.' })
  }

  if (q.outliers.length) {
    const notes: Record<string, string> = {}
    for (const o of q.outliers) notes[o.column] = `${pct(o.share)} atypiques`
    steps.push({ kind: 'cap_outliers', columns: q.outliers.map((o) => o.column), columnNotes: notes, recommended: false,
      title: 'Plafonner les valeurs atypiques',
      detail: 'Ramène les valeurs extrêmes aux bornes habituelles (méthode IQR, 1,5 × l’écart interquartile). À réserver aux erreurs de saisie probables.' })
  }
  return steps
}

async function scalar(conn: DuckDBConnection, sql: string): Promise<unknown> {
  const r = await conn.runAndReadAll(sql)
  const v = r.getRowsJson()[0]?.[0]
  return typeof v === 'bigint' ? Number(v) : v
}

/** Applique les étapes et importe le résultat comme nouveau jeu de données. */
export async function applyCleaning(store: Store, meta: DatasetMeta, p: Profile, steps: CleanStep[]): Promise<{ dataset: DatasetMeta; report: string[] }> {
  const known = new Set(p.columns.map((c) => c.name))
  const kinds = new Map(p.columns.map((c) => [c.name, c]))
  const valid = steps
    .filter((s) => ['dedupe', 'trim', 'convert', 'drop_columns', 'fill_missing', 'cap_outliers'].includes(s.kind))
    .map((s) => ({ kind: s.kind, columns: (Array.isArray(s.columns) ? s.columns : []).map(String).filter((c) => known.has(c)) }))
    .filter((s) => s.kind === 'dedupe' || s.columns.length)
  if (!valid.length) throw new Error('Aucune étape de nettoyage sélectionnée.')
  const has = (k: CleanStepKind) => valid.find((s) => s.kind === k)

  const target = store.tmpPath('nettoye.parquet')
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  const report: string[] = []
  try {
    await conn.run(`SET threads = 2`)
    await conn.run(`CREATE TABLE t AS SELECT * FROM read_parquet(${quoteString(store.parquetPath(meta.id))})`)
    const before = Number(await scalar(conn, 'SELECT count(*) FROM t'))
    let columns = p.columns.map((c) => c.name)
    const rebuild = async (expr: (c: string) => string) => {
      await conn.run(`CREATE OR REPLACE TABLE t AS SELECT ${columns.map((c) => `${expr(c)} AS ${quoteIdent(c)}`).join(', ')} FROM t`)
    }

    const trim = has('trim')
    if (trim) {
      const set = new Set(trim.columns)
      await rebuild((c) => (set.has(c) ? `NULLIF(trim(${quoteIdent(c)}), '')` : quoteIdent(c)))
      report.push(`Espaces nettoyés dans ${trim.columns.length} colonne(s).`)
    }
    const convert = has('convert')
    if (convert) {
      const set = new Set(convert.columns)
      await rebuild((c) => (set.has(c)
        ? `TRY_CAST(replace(replace(replace(replace(trim(${quoteIdent(c)}::VARCHAR), ' ', ''), chr(160), ''), chr(8239), ''), ',', '.') AS DOUBLE)`
        : quoteIdent(c)))
      report.push(`${convert.columns.length} colonne(s) converties en nombres : ${convert.columns.map((c) => `\`${c}\``).join(', ')}.`)
    }
    const drop = has('drop_columns')
    if (drop) {
      const set = new Set(drop.columns)
      if (set.size >= columns.length) throw new Error('Impossible de retirer toutes les colonnes.')
      columns = columns.filter((c) => !set.has(c))
      await rebuild((c) => quoteIdent(c))
      report.push(`${set.size} colonne(s) retirée(s) : ${drop.columns.map((c) => `\`${c}\``).join(', ')}.`)
    }
    if (has('dedupe')) {
      // Garde la première occurrence de chaque ligne, dans l'ordre d'origine.
      const all = columns.map(quoteIdent).join(', ')
      await conn.run(`CREATE OR REPLACE TABLE t AS SELECT * EXCLUDE (__rang) FROM (
        SELECT *, row_number() OVER () AS __rang FROM t
      ) QUALIFY row_number() OVER (PARTITION BY ${all} ORDER BY __rang) = 1 ORDER BY __rang`)
      const after = Number(await scalar(conn, 'SELECT count(*) FROM t'))
      report.push(`${before - after} doublon(s) supprimé(s).`)
    }
    const fill = has('fill_missing')
    if (fill) {
      const values = new Map<string, string>()
      for (const c of fill.columns.filter((x) => columns.includes(x))) {
        const q = quoteIdent(c)
        const numeric = isNumericType(kinds.get(c)!.type) || convert?.columns.includes(c)
        const v = numeric
          ? await scalar(conn, `SELECT median(${q})::DOUBLE FROM t`)
          : await scalar(conn, `SELECT ${q} FROM t WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)
        if (v === null || v === undefined) continue
        const n = Number(await scalar(conn, `SELECT count(*) FROM t WHERE ${q} IS NULL`))
        if (!n) continue
        values.set(c, numeric ? String(Number(v)) : `${quoteString(String(v))}`)
        report.push(`\`${c}\` : ${n} valeur(s) manquante(s) complétée(s) par ${numeric ? 'la médiane' : 'la valeur la plus fréquente'} (${String(v)}).`)
      }
      if (values.size) await rebuild((c) => (values.has(c) ? `coalesce(${quoteIdent(c)}, ${values.get(c)})` : quoteIdent(c)))
    }
    const cap = has('cap_outliers')
    if (cap) {
      const bounds = new Map<string, [number, number]>()
      for (const c of cap.columns.filter((x) => columns.includes(x))) {
        const q = quoteIdent(c)
        const r = await conn.runAndReadAll(`SELECT quantile_cont(${q}, 0.25)::DOUBLE, quantile_cont(${q}, 0.75)::DOUBLE FROM t`)
        const [q1, q3] = (r.getRowsJson()[0] ?? []).map(Number)
        if (!Number.isFinite(q1) || !Number.isFinite(q3) || q3 <= q1) continue
        const lo = q1 - 1.5 * (q3 - q1), hi = q3 + 1.5 * (q3 - q1)
        const n = Number(await scalar(conn, `SELECT count(*) FROM t WHERE ${q} < ${lo} OR ${q} > ${hi}`))
        if (!n) continue
        bounds.set(c, [lo, hi])
        report.push(`\`${c}\` : ${n} valeur(s) ramenée(s) entre ${+lo.toPrecision(4)} et ${+hi.toPrecision(4)}.`)
      }
      if (bounds.size) {
        await rebuild((c) => {
          const b = bounds.get(c)
          return b ? `CASE WHEN ${quoteIdent(c)} IS NULL THEN NULL ELSE least(greatest(${quoteIdent(c)}, ${b[0]}), ${b[1]}) END` : quoteIdent(c)
        })
      }
    }
    await conn.run(`COPY t TO ${quoteString(target)} (FORMAT parquet, COMPRESSION zstd)`)
  } finally {
    conn.closeSync()
    instance.closeSync()
  }

  try {
    const base = meta.name.replace(/\.[^.]+$/, '').replace(/ \(nettoyé.*\)$/, '')
    const created = await importFile(store, target, `${base.replace(/[^\w.-]+/g, '_')}_nettoye.parquet`)
    created.name = `${base} (nettoyé)`
    created.cleanedFrom = meta.id
    created.links = meta.links
    await store.saveDataset(created)
    return { dataset: created, report: report.length ? report : ['Aucune modification nécessaire : les données étaient déjà propres.'] }
  } finally {
    await rm(target, { force: true })
  }
}
