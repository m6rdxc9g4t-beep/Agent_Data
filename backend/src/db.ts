// Moteur de requêtes : une base DuckDB en mémoire par jeu de données, verrouillée en lecture seule.
//
// Chaque jeu de données est stocké en Parquet. À l'ouverture, il est chargé dans la table `data`
// d'une base en mémoire, puis l'accès aux fichiers est coupé (enable_external_access = false) et la
// configuration verrouillée : les requêtes écrites par l'IA ne peuvent ni lire ni écrire de fichier.
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

export type Cell = string | number | boolean | null
export interface Column { name: string; type: string }
export interface QueryResult { columns: Column[]; rows: Cell[][]; truncated: boolean }

export class QueryError extends Error {}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)/

export function isNumericType(type: string): boolean {
  return NUMERIC.test(type)
}

export function isTemporalType(type: string): boolean {
  return /^(DATE|TIMESTAMP|TIME)/.test(type)
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function convert(value: unknown, type: string): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value
  }
  if (typeof value === 'string') {
    if (isNumericType(type)) {
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    }
    return value
  }
  return JSON.stringify(value)
}

const ALLOWED_START = /^(select|with|from|summarize|describe|pivot|unpivot|values|table|show)\b/i

/** Une seule instruction de lecture (SELECT, WITH, FROM, SUMMARIZE, DESCRIBE, PIVOT…). */
export function assertReadOnly(sql: string): string {
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/;+\s*$/, '')
  if (!cleaned) throw new QueryError('Requête vide.')
  if (!ALLOWED_START.test(cleaned)) {
    throw new QueryError('Seules les requêtes de lecture sont autorisées (SELECT, WITH, SUMMARIZE, PIVOT…).')
  }
  return cleaned
}

export class DatasetDb {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    private readonly timeoutMs: number,
  ) {}

  static async open(parquetPath: string, timeoutMs = 60_000): Promise<DatasetDb> {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`SET threads = 2; SET memory_limit = '1GB'`)
    await conn.run(`CREATE TABLE data AS SELECT * FROM read_parquet(${quoteString(parquetPath)})`)
    await conn.run('SET enable_external_access = false')
    await conn.run('SET lock_configuration = true')
    return new DatasetDb(instance, conn, timeoutMs)
  }

  /** Exécute une requête (déjà validée ou interne) et lit au plus `limit` lignes. */
  async query(sql: string, limit = 500): Promise<QueryResult> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.conn.interrupt()
        reject(new QueryError(`Requête interrompue : plus de ${Math.round(this.timeoutMs / 1000)} s.`))
      }, this.timeoutMs)
    })
    try {
      const reader = await Promise.race([this.conn.streamAndReadUntil(sql, limit + 1), timeout])
      const names = reader.deduplicatedColumnNames()
      const types = reader.columnTypes().map((t) => t.toString())
      const raw = reader.getRowsJson() as unknown[][]
      const truncated = raw.length > limit || !reader.done
      const rows = raw.slice(0, limit).map((r) => r.map((v, i) => convert(v, types[i])))
      return { columns: names.map((name, i) => ({ name, type: types[i] })), rows, truncated }
    } catch (err) {
      if (err instanceof QueryError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new QueryError(message.replace(/^[A-Za-z ]+Error: /, ''))
    } finally {
      clearTimeout(timer)
    }
  }

  /** Requête écrite par l'IA ou l'utilisateur : contrôle « lecture seule » puis exécution. */
  async safeQuery(sql: string, limit = 500): Promise<QueryResult> {
    const cleaned = assertReadOnly(sql)
    const statements = await this.conn.extractStatements(cleaned).catch((e: Error) => {
      throw new QueryError(e.message.replace(/^[A-Za-z ]+Error: /, ''))
    })
    if (statements.count !== 1) throw new QueryError('Une seule requête à la fois.')
    return this.query(cleaned, limit)
  }

  async scalar<T extends Cell>(sql: string): Promise<T> {
    const r = await this.query(sql, 1)
    return r.rows[0]?.[0] as T
  }

  close(): void {
    try {
      this.conn.closeSync()
      this.instance.closeSync()
    } catch {
      /* déjà fermée */
    }
  }
}

/** Petit cache LRU des bases ouvertes. */
export class DbCache {
  private readonly map = new Map<string, Promise<DatasetDb>>()
  constructor(private readonly max = 4, private readonly timeoutMs = 60_000) {}

  get(id: string, parquetPath: string): Promise<DatasetDb> {
    const hit = this.map.get(id)
    if (hit) {
      this.map.delete(id)
      this.map.set(id, hit)
      return hit
    }
    const p = DatasetDb.open(parquetPath, this.timeoutMs)
    p.catch(() => this.map.delete(id))
    this.map.set(id, p)
    while (this.map.size > this.max) {
      const [oldId, old] = this.map.entries().next().value as [string, Promise<DatasetDb>]
      this.map.delete(oldId)
      old.then((db) => db.close()).catch(() => {})
    }
    return p
  }

  drop(id: string): void {
    const p = this.map.get(id)
    this.map.delete(id)
    p?.then((db) => db.close()).catch(() => {})
  }
}
