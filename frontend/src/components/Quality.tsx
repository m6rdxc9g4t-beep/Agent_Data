// Onglet Qualité : score, recommandations et profil des colonnes.
import { useEffect, useState } from 'react'
import { BookText, ShieldCheck } from 'lucide-react'

import { api } from '../api'

import { fmtCell, fmtInt, fmtNumber, fmtPct } from '../format'
import type { DatasetDetail, DatasetMeta, Kind } from '../types'
import { CleanPanel } from './CleanPanel'

export const KIND_LABELS: Record<Kind, string> = {
  numeric: 'Numérique', datetime: 'Date', boolean: 'Booléen', category: 'Catégorie', text: 'Texte', id: 'Identifiant', constant: 'Constante',
}

function Inline({ text }: { text: string }) {
  return <>{text.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>
}

/** Champ de description enregistré à la sortie du champ (dictionnaire des colonnes). */
function DescInput({ value, placeholder, onSave, multiline }: { value: string; placeholder: string; onSave: (v: string) => void; multiline?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { if (text.trim() !== value) onSave(text.trim()) }
  return multiline
    ? <textarea className="desc-input" rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} maxLength={2000} />
    : <input className="desc-input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} maxLength={300} />
}

export function Quality({ dataset, onAudit, canAudit, onCleaned, onOpen, onPatched }: {
  dataset: DatasetDetail; onAudit: () => void; canAudit: boolean; onCleaned: (m: DatasetMeta) => void; onOpen: (id: string) => void
  onPatched: (m: DatasetMeta) => void
}) {
  const [saveError, setSaveError] = useState<string | null>(null)
  const patch = (p: { descriptions?: Record<string, string>; context?: string }) =>
    api.updateDataset(dataset.id, p).then((m) => { onPatched(m); setSaveError(null) }).catch((e: Error) => setSaveError(e.message))
  const q = dataset.profile.quality
  const tone = q.score >= 75 ? 'good' : q.score >= 55 ? 'mid' : 'bad'
  return (
    <div className="panel-scroll">
      <section className="quality-top">
        <div className="atelier-kpi score-card">
        <div className={`score score-${tone}`}>
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle cx="60" cy="60" r="52" className="score-track" />
            <circle cx="60" cy="60" r="52" className="score-value" strokeDasharray={`${(q.score / 100) * 326.7} 326.7`} />
          </svg>
          <div className="score-text"><strong>{q.score}</strong><span>sur 100</span></div>
        </div>
        </div>
        <div className="score-explain">
          <h2>Qualité {q.grade.toLowerCase()}</h2>
          <p>Le score combine la complétude des cellules ({fmtPct(q.completeness)}), l’absence de doublons ({fmtInt(q.duplicateRows)} ligne{q.duplicateRows > 1 ? 's' : ''} en double), l’intérêt des colonnes et la cohérence des types.</p>
          <button type="button" className="ghost-btn" onClick={onAudit} disabled={!canAudit}><ShieldCheck size={15} /> Demander un audit détaillé à l’agent</button>
        </div>
        <div className="recos">
          <h3>À faire</h3>
          <ul>{q.recommendations.map((r, i) => <li key={i}><Inline text={r} /></li>)}</ul>
        </div>
      </section>

      <CleanPanel dataset={dataset} onCreated={onCleaned} onOpen={onOpen} />

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Profil et dictionnaire des colonnes</h2>
          <span className="muted small"><BookText size={14} /> Les significations saisies ici sont transmises à l’agent.</span>
        </div>
        <label className="context-field">
          <span>Contexte du jeu de données</span>
          <DescInput multiline value={dataset.context ?? ''} onSave={(v) => patch({ context: v })}
            placeholder="Ex. : export des ventes 2024 du magasin de Lyon, montants en euros HT, une ligne par ticket de caisse." />
        </label>
        {saveError && <p className="hint-warn">{saveError}</p>}
        <div className="result-table profile-table">
          <table>
            <thead>
              <tr><th>Colonne</th><th>Signification</th><th>Type</th><th>Renseignées</th><th className="num">Distinctes</th><th className="num">Min</th><th className="num">Médiane</th><th className="num">Max</th><th>Valeur fréquente</th></tr>
            </thead>
            <tbody>
              {dataset.profile.columns.map((c) => (
                <tr key={c.name}>
                  <td className="col-name">{c.name}</td>
                  <td className="desc-cell">
                    <DescInput value={dataset.descriptions?.[c.name] ?? ''} placeholder="Ajouter…"
                      onSave={(v) => patch({ descriptions: { [c.name]: v } })} />
                  </td>
                  <td><span className={`kind kind-${c.kind}`}>{KIND_LABELS[c.kind]}</span></td>
                  <td>
                    <span className="bar" aria-label={fmtPct(c.completeness)}><span style={{ width: `${c.completeness * 100}%` }} className={c.completeness < 0.8 ? 'low' : undefined} /></span>
                    <span className="bar-label">{fmtPct(c.completeness, 0)}</span>
                  </td>
                  <td className="num">{fmtInt(c.distinct)}</td>
                  <td className="num">{c.kind === 'numeric' || c.kind === 'datetime' ? fmtCell(c.min) : ''}</td>
                  <td className="num">{c.median !== null && c.kind === 'numeric' ? fmtNumber(c.median) : ''}</td>
                  <td className="num">{c.kind === 'numeric' || c.kind === 'datetime' ? fmtCell(c.max) : ''}</td>
                  <td className="ellipsis">{c.top ? `${c.top} (${fmtInt(c.topCount ?? 0)})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
