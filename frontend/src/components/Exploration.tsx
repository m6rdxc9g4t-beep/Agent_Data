// Onglet Exploration : graphiques automatiques et exploration colonne par colonne (sans IA).
import { useEffect, useState } from 'react'

import { api } from '../api'
import { fmtCell, fmtInt, fmtNumber, fmtPct } from '../format'
import type { ChartSpec, ColumnProfile, DatasetDetail, TableData } from '../types'
import { ChartFigure } from './Chart'
import { ResultTable } from './ResultTable'
import { KIND_LABELS } from './Quality'

export function Exploration({ dataset }: { dataset: DatasetDetail }) {
  const [charts, setCharts] = useState<ChartSpec[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const columns = dataset.profile.columns
  const [selected, setSelected] = useState(columns.find((c) => c.kind === 'numeric')?.name ?? columns[0]?.name)
  const [detail, setDetail] = useState<{ column: ColumnProfile; chart: ChartSpec | null; top: TableData } | null>(null)

  useEffect(() => {
    setCharts(null)
    api.charts(dataset.id).then(setCharts).catch((e: Error) => setError(e.message))
  }, [dataset.id])

  useEffect(() => {
    if (!selected) return
    setDetail(null)
    api.column(dataset.id, selected).then(setDetail).catch(() => setDetail(null))
  }, [dataset.id, selected])

  const c = detail?.column
  const stats: [string, string][] = !c ? [] : c.kind === 'numeric'
    ? [['Moyenne', fmtNumber(c.mean ?? NaN)], ['Médiane', fmtNumber(c.median ?? NaN)], ['Écart-type', fmtNumber(c.std ?? NaN)],
      ['Minimum', fmtCell(c.min)], ['Maximum', fmtCell(c.max)]]
    : c.kind === 'datetime'
      ? [['Première date', fmtCell(c.min)], ['Dernière date', fmtCell(c.max)]]
      : [['Valeur la plus fréquente', c.top ?? '—'], ['Occurrences', c.topCount ? fmtInt(c.topCount) : '—']]

  return (
    <div className="panel-scroll">
      <section className="section">
        <h2 className="section-title">Vue d’ensemble automatique</h2>
        {error && <p className="hint-warn">{error}</p>}
        {!charts && !error && <div className="grid-2">{[0, 1, 2, 3].map((i) => <div key={i} className="figure skeleton" />)}</div>}
        {charts && charts.length === 0 && <p className="muted">Pas assez de colonnes structurées pour proposer des graphiques.</p>}
        {charts && <div className="grid-2">{charts.map((s, i) => <ChartFigure key={i} spec={s} height={260} pinSource="Exploration automatique" />)}</div>}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Explorer une colonne</h2>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Colonne à explorer">
            {columns.map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}
          </select>
        </div>
        <div className="column-explorer">
          <div>{detail?.chart ? <ChartFigure spec={detail.chart} height={280} pinSource={`Exploration de « ${selected} »`} /> : <div className="figure skeleton" />}</div>
          <aside className="column-facts">
            {c && (
              <>
                <p className="facts-kind">{KIND_LABELS[c.kind]} <span>{c.type}</span></p>
                <dl>
                  <div><dt>Renseignées</dt><dd>{fmtPct(c.completeness)}</dd></div>
                  <div><dt>Valeurs distinctes</dt><dd>{fmtInt(c.distinct)}</dd></div>
                  {stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                </dl>
                {c.kind !== 'numeric' && detail?.top && <ResultTable table={detail.top} maxRows={8} />}
              </>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}
