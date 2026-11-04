// Onglet Qualité : score, recommandations et profil des colonnes.
import { ShieldCheck } from 'lucide-react'

import { fmtCell, fmtInt, fmtNumber, fmtPct } from '../format'
import type { DatasetDetail, Kind } from '../types'

export const KIND_LABELS: Record<Kind, string> = {
  numeric: 'Numérique', datetime: 'Date', boolean: 'Booléen', category: 'Catégorie', text: 'Texte', id: 'Identifiant', constant: 'Constante',
}

function Inline({ text }: { text: string }) {
  return <>{text.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>
}

export function Quality({ dataset, onAudit, canAudit }: { dataset: DatasetDetail; onAudit: () => void; canAudit: boolean }) {
  const q = dataset.profile.quality
  const tone = q.score >= 75 ? 'good' : q.score >= 55 ? 'mid' : 'bad'
  return (
    <div className="panel-scroll">
      <section className="quality-top">
        <div className={`score score-${tone}`}>
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle cx="60" cy="60" r="52" className="score-track" />
            <circle cx="60" cy="60" r="52" className="score-value" strokeDasharray={`${(q.score / 100) * 326.7} 326.7`} />
          </svg>
          <div className="score-text"><strong>{q.score}</strong><span>sur 100</span></div>
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

      <section className="section">
        <h2 className="section-title">Profil des colonnes</h2>
        <div className="result-table profile-table">
          <table>
            <thead>
              <tr><th>Colonne</th><th>Type</th><th>Renseignées</th><th className="num">Distinctes</th><th className="num">Min</th><th className="num">Médiane</th><th className="num">Max</th><th>Valeur fréquente</th></tr>
            </thead>
            <tbody>
              {dataset.profile.columns.map((c) => (
                <tr key={c.name}>
                  <td className="col-name">{c.name}</td>
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
