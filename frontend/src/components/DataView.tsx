// Onglet Données : table paginée côté serveur, recherche, tri et export CSV.
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react'

import { api } from '../api'
import { fmtCell, fmtInt } from '../format'
import type { DatasetDetail, TableData } from '../types'

const PAGE = 100
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL|U)/

export function DataView({ dataset }: { dataset: DatasetDetail }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState<{ total: number; columns: TableData['columns']; rows: unknown[][] } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => { setQuery(q); setOffset(0) }, 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    setLoading(true)
    api.rows(dataset.id, { offset, limit: PAGE, q: query, sort: sort?.col, dir: sort?.dir })
      .then(setPage).finally(() => setLoading(false))
  }, [dataset.id, offset, query, sort])

  const toggleSort = (col: string) => {
    setOffset(0)
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))
  }
  const total = page?.total ?? 0

  return (
    <div className="data-view">
      <div className="data-toolbar">
        <label className="search">
          <Search size={15} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer les lignes contenant…" aria-label="Filtrer les lignes" />
        </label>
        <span className="muted">{loading ? 'Chargement…' : `${fmtInt(total)} ligne${total > 1 ? 's' : ''}`}</span>
        <div className="pager">
          <button type="button" className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Page précédente"><ChevronLeft size={16} /></button>
          <span>{total ? `${fmtInt(offset + 1)}–${fmtInt(Math.min(offset + PAGE, total))}` : '0'}</span>
          <button type="button" className="icon-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} aria-label="Page suivante"><ChevronRight size={16} /></button>
        </div>
        <a className="ghost-btn" href={api.exportUrl(dataset.id, query)} download><Download size={15} /> Télécharger en CSV</a>
      </div>
      <div className="grid-table">
        <table>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {dataset.columns.map((c) => (
                <th key={c.name} className={NUMERIC.test(c.type) ? 'num' : undefined}>
                  <button type="button" onClick={() => toggleSort(c.name)} title={`Trier par ${c.name}`}>
                    {c.name}
                    {sort?.col === c.name && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((r, i) => (
              <tr key={offset + i}>
                <td className="rownum">{fmtInt(offset + i + 1)}</td>
                {r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : undefined}>{v === null ? <span className="null">vide</span> : fmtCell(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {page && page.rows.length === 0 && <p className="empty-note">Aucune ligne ne contient « {query} ».</p>}
      </div>
    </div>
  )
}
