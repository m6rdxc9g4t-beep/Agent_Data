// Import d'un fichier (CSV, TSV, Excel, JSON, JSON Lines, Parquet) en Parquet, via DuckDB.
//   - texte : encodage (UTF-8 ou Windows-1252) et séparateur détectés, format français (; et virgule décimale) ;
//   - Excel : feuille au choix ;
//   - dates reconnues par le détecteur de DuckDB.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { DuckDBInstance } from '@duckdb/node-api'
import * as XLSX from 'xlsx'

import { quoteString, type Column } from './db.js'
import type { DatasetMeta, Store } from './store.js'

export const SUPPORTED = ['.csv', '.tsv', '.txt', '.xlsx', '.xls', '.json', '.jsonl', '.ndjson', '.parquet']

export class ImportError extends Error {}

export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}

/** Séparateur le plus régulier sur les premières lignes (hors guillemets). */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 50)
  let best = ',', bestScore = -1
  for (const d of [';', ',', '\t', '|']) {
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1)
    if (!counts.length || counts[0] === 0) continue
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length
    const score = consistent * 100 + counts[0]
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

function readerFor(path: string, ext: string, delim: string, decimal: string): string {
  const p = quoteString(path)
  switch (ext) {
    case '.json':
      return `read_json_auto(${p})`
    case '.jsonl':
    case '.ndjson':
      return `read_json_auto(${p}, format = 'newline_delimited')`
    case '.parquet':
      return `read_parquet(${p})`
    default:
      return `read_csv(${p}, delim = ${quoteString(delim)}, decimal_separator = ${quoteString(decimal)}, ` +
        `header = true, sample_size = 20480, null_padding = true, normalize_names = false)`
  }
}

async function toParquet(source: string, ext: string, target: string, delim = ',', decimal = '.'): Promise<{ rows: number; columns: Column[] }> {
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  try {
    await conn.run(`SET threads = 2`)
    await conn.run(`CREATE TABLE src AS SELECT * FROM ${readerFor(source, ext, delim, decimal)}`)
    const desc = await conn.runAndReadAll('DESCRIBE src')
    const columns = (desc.getRowObjectsJson() as Record<string, string>[])
      .map((r) => ({ name: r.column_name, type: r.column_type }))
    if (!columns.length) throw new ImportError('Le fichier ne contient aucune colonne exploitable.')
    const count = await conn.runAndReadAll('SELECT count(*) FROM src')
    const rows = Number(count.getRowsJson()[0][0])
    if (rows === 0) throw new ImportError('Le fichier ne contient aucune ligne de données.')
    await conn.run(`COPY src TO ${quoteString(target)} (FORMAT parquet, COMPRESSION zstd)`)
    return { rows, columns }
  } catch (err) {
    if (err instanceof ImportError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new ImportError(`Lecture impossible : ${msg.split('\n')[0].replace(/^[A-Za-z ]+Error: /, '')}`)
  } finally {
    conn.closeSync()
    instance.closeSync()
  }
}

export function excelSheets(buf: Buffer): string[] {
  return XLSX.read(buf, { type: 'buffer', bookSheets: true }).SheetNames
}

function excelToCsv(buf: Buffer, sheet: string | null): { csv: string; sheets: string[]; sheet: string } {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const name = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0]
  if (!name) throw new ImportError('Le classeur ne contient aucune feuille.')
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { rawNumbers: true, dateNF: 'yyyy-mm-dd', blankrows: false })
  return { csv, sheets: wb.SheetNames, sheet: name }
}

/** Importe `sourcePath` comme nouveau jeu de données (ou remplace `existingId`). */
export async function importFile(
  store: Store,
  sourcePath: string,
  fileName: string,
  opts: { sheet?: string | null; existingId?: string; sample?: boolean } = {},
): Promise<DatasetMeta> {
  const ext = extname(fileName).toLowerCase()
  if (!SUPPORTED.includes(ext)) {
    throw new ImportError(`Format non pris en charge : « ${ext || fileName} ». Formats acceptés : ${SUPPORTED.join(', ')}.`)
  }
  const id = opts.existingId ?? randomUUID()
  const dir = store.datasetDir(id)
  await mkdir(dir, { recursive: true })
  const kept = join(dir, `source${ext}`)
  if (sourcePath !== kept) await writeFile(kept, await readFile(sourcePath))
  const target = join(dir, 'data.parquet')
  const work = store.tmpPath(`work${ext}.csv`)

  let sheets: string[] = []
  let sheet: string | null = null
  try {
    let result
    const raw = await readFile(kept)
    if (ext === '.xlsx' || ext === '.xls') {
      const x = excelToCsv(raw, opts.sheet ?? null)
      sheets = x.sheets
      sheet = x.sheet
      await writeFile(work, x.csv, 'utf8')
      result = await toParquet(work, '.csv', target, ',', '.')
    } else if (['.csv', '.tsv', '.txt'].includes(ext)) {
      const text = decodeText(raw)
      if (!text.trim()) throw new ImportError('Le fichier est vide.')
      const delim = ext === '.tsv' ? '\t' : sniffDelimiter(text)
      const decimal = delim === ';' ? ',' : '.'
      await writeFile(work, text, 'utf8')
      result = await toParquet(work, '.csv', target, delim, decimal)
    } else {
      result = await toParquet(kept, ext, target)
    }
    const meta: DatasetMeta = {
      id,
      name: fileName,
      fileName,
      format: ext.slice(1).toUpperCase(),
      rows: result.rows,
      columns: result.columns,
      sizeBytes: (await stat(kept)).size,
      createdAt: new Date().toISOString(),
      sheets,
      sheet,
      sample: !!opts.sample,
    }
    await store.saveDataset(meta)
    return meta
  } catch (err) {
    if (!opts.existingId) await rm(dir, { recursive: true, force: true })
    throw err
  } finally {
    await rm(work, { force: true })
  }
}
