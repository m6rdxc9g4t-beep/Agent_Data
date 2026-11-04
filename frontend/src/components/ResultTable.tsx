import { fmtCell } from '../format'
import type { TableData } from '../types'

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/

export function ResultTable({ table, maxRows = 50 }: { table: TableData; maxRows?: number }) {
  const rows = table.rows.slice(0, maxRows)
  const numeric = table.columns.map((c) => NUMERIC.test(c.type))
  return (
    <div className="result-table">
      <table>
        <thead>
          <tr>{table.columns.map((c, i) => <th key={i} className={numeric[i] ? 'num' : undefined}>{c.name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={numeric[j] || typeof v === 'number' ? 'num' : undefined}>
                  {v === null || v === undefined ? <span className="null">vide</span> : fmtCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.rows.length > maxRows || table.truncated) && (
        <p className="table-note">{table.truncated ? 'Résultat tronqué' : `${table.rows.length - maxRows} ligne(s) masquée(s)`}</p>
      )}
    </div>
  )
}
