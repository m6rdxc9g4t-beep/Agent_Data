// Onglet Tableau de bord : les résultats épinglés depuis l'Assistant, l'Exploration et la Prédiction.
import { useState } from 'react'
import { ArrowDown, ArrowUp, Code2, Columns2, Pin as PinIcon, Printer, Square, Trash2 } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useTheme } from '../theme'
import type { DatasetDetail, Pin } from '../types'
import { Chart } from './Chart'
import { ResultTable } from './ResultTable'

interface Props {
  dataset: DatasetDetail
  pins: Pin[]
  onUpdate: (pin: Pin, patch: { title?: string; note?: string; wide?: boolean }) => void
  onRemove: (pin: Pin) => void
  onMove: (pin: Pin, delta: -1 | 1) => void
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function PinCard({ pin, first, last, onUpdate, onRemove, onMove }: Omit<Props, 'dataset' | 'pins'> & { pin: Pin; first: boolean; last: boolean }) {
  const [title, setTitle] = useState(pin.title)
  const [note, setNote] = useState(pin.note ?? '')
  const [showSql, setShowSql] = useState(false)
  const saveTitle = () => { const t = title.trim(); if (t && t !== pin.title) onUpdate(pin, { title: t }); else setTitle(pin.title) }
  const saveNote = () => { if (note !== (pin.note ?? '')) onUpdate(pin, { note }) }
  return (
    <article className={`pin-card${pin.wide ? ' wide' : ''}`}>
      <header>
        <div className="pin-head">
          <input className="pin-title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Titre" />
          <span className="pin-source">{pin.source || 'Épinglé'} · {fmtDate(pin.createdAt)}</span>
        </div>
        <div className="pin-tools">
          {pin.sql && <button type="button" className="icon-btn small" onClick={() => setShowSql(!showSql)} title="Voir la requête" aria-pressed={showSql}><Code2 size={14} /></button>}
          {pin.kind === 'chart' && (
            <button type="button" className="icon-btn small" onClick={() => onUpdate(pin, { wide: !pin.wide })} title={pin.wide ? 'Demi-largeur' : 'Pleine largeur'}>
              {pin.wide ? <Square size={14} /> : <Columns2 size={14} />}
            </button>
          )}
          <button type="button" className="icon-btn small" onClick={() => onMove(pin, -1)} disabled={first} title="Monter"><ArrowUp size={14} /></button>
          <button type="button" className="icon-btn small" onClick={() => onMove(pin, 1)} disabled={last} title="Descendre"><ArrowDown size={14} /></button>
          <button type="button" className="icon-btn small" onClick={() => onRemove(pin)} title="Retirer du tableau de bord"><Trash2 size={14} /></button>
        </div>
      </header>
      {showSql && pin.sql && <pre className="sql"><code>{pin.sql}</code></pre>}
      <div className="pin-body">
        {pin.kind === 'chart' && pin.chart && (
          <>
            {pin.chart.subtitle && <p className="pin-sub">{pin.chart.subtitle}</p>}
            <Chart spec={pin.chart} height={pin.wide ? 360 : 280} />
          </>
        )}
        {pin.kind === 'table' && pin.table && <ResultTable table={pin.table} maxRows={50} />}
        {pin.kind === 'text' && pin.text && <div className="answer flat"><Markdown remarkPlugins={[remarkGfm]}>{pin.text}</Markdown></div>}
      </div>
      <textarea className="pin-note" value={note} rows={1} placeholder="Ajouter un commentaire…" onChange={(e) => setNote(e.target.value)} onBlur={saveNote}
        aria-label="Commentaire" />
    </article>
  )
}

export function Dashboard({ dataset, pins, onUpdate, onRemove, onMove }: Props) {
  const { print } = useTheme()
  if (!pins.length) {
    return (
      <div className="panel-scroll">
        <div className="dash-empty">
          <PinIcon size={26} strokeWidth={1.6} />
          <h2>Votre tableau de bord est vide</h2>
          <p>Épinglez ici les graphiques, tableaux et réponses qui comptent : bouton <strong>Épingler</strong> sur chaque résultat
            de l’Assistant, de l’Exploration et de la Prédiction. Vous pourrez les réordonner, les commenter et tout exporter en PDF.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="panel-scroll dashboard">
      <div className="dash-head">
        <div>
          <h2 className="section-title">Tableau de bord</h2>
          <p className="muted">{dataset.name} · {pins.length} élément{pins.length > 1 ? 's' : ''}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={print}><Printer size={15} /> <span className="btn-label">Exporter en PDF</span></button>
      </div>
      <p className="print-only print-title">{dataset.name} — tableau de bord DataMind, {new Date().toLocaleDateString('fr-FR', { dateStyle: 'long' })}</p>
      <div className="pin-grid">
        {pins.map((p, i) => (
          <PinCard key={p.id} pin={p} first={i === 0} last={i === pins.length - 1} onUpdate={onUpdate} onRemove={onRemove} onMove={onMove} />
        ))}
      </div>
    </div>
  )
}
