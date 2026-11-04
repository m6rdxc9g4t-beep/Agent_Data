// Fichiers liés : d'autres jeux chargés à côté de `data` pour que l'agent puisse les croiser (jointures SQL).
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Link2, LoaderCircle, Plus, X } from 'lucide-react'

import { api } from '../api'
import { fmtInt, fmtPct } from '../format'
import type { DatasetDetail, DatasetMeta, LinkInfo, LinkSuggestion } from '../types'

export function LinkBar({ dataset, links, onAdd, onRemove }: {
  dataset: DatasetDetail; links: LinkInfo[]; onAdd: () => void; onRemove: (l: LinkInfo) => void
}) {
  return (
    <div className="link-bar">
      <Link2 size={14} aria-hidden />
      {links.length === 0 && <span className="muted">Aucun fichier lié</span>}
      {links.map((l) => (
        <span key={l.id} className="link-chip" title={`${l.name} · ${fmtInt(l.rows)} lignes · table SQL ${l.table}`}>
          <code>{l.table}</code>
          {l.keys[0] && <span className="link-key">par {l.keys[0].column}</span>}
          <button type="button" onClick={() => onRemove(l)} aria-label={`Délier ${l.name}`} title="Délier"><X size={12} /></button>
        </span>
      ))}
      {links.length < 5 && (
        <button type="button" className="link-add" onClick={onAdd} disabled={!dataset}>
          <Plus size={13} /> {links.length ? 'Lier' : 'Lier un fichier à croiser'}
        </button>
      )}
    </div>
  )
}

export function LinkDialog({ dataset, datasets, links, onClose, onSave }: {
  dataset: DatasetDetail; datasets: DatasetMeta[]; links: LinkInfo[]; onClose: () => void; onSave: (otherId: string, table: string) => Promise<void>
}) {
  const candidates = datasets.filter((d) => d.id !== dataset.id && !links.some((l) => l.id === d.id))
  const [other, setOther] = useState(candidates[0]?.id ?? '')
  const [sugg, setSugg] = useState<LinkSuggestion | null>(null)
  const [table, setTable] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!other) return
    setSugg(null)
    setError(null)
    api.suggestLink(dataset.id, other).then((s) => { setSugg(s); setTable(s.table) }).catch((e: Error) => setError(e.message))
  }, [dataset.id, other])

  const otherMeta = datasets.find((d) => d.id === other)
  const save = async () => {
    setSaving(true)
    try { await onSave(other, table) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog narrow" role="dialog" aria-modal="true" aria-labelledby="link-title">
        <header>
          <div>
            <h2 id="link-title">Lier un fichier</h2>
            <p>Le fichier lié devient une table SQL à côté de <code>data</code> : l’agent peut croiser les deux, par exemple commandes et clients.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>
        {candidates.length === 0 ? (
          <p className="muted">Importez d’abord un autre fichier (ou chargez un jeu d’exemple) pour pouvoir le lier.</p>
        ) : (
          <div className="link-form">
            <label>
              <span>Fichier à lier</span>
              <select value={other} onChange={(e) => setOther(e.target.value)}>
                {candidates.map((d) => <option key={d.id} value={d.id}>{d.name} ({fmtInt(d.rows)} lignes)</option>)}
              </select>
            </label>
            <label>
              <span>Nom de la table SQL</span>
              <input value={table} onChange={(e) => setTable(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} maxLength={40} spellCheck={false} />
            </label>
            <div className="link-keys">
              <span className="label">Colonnes communes</span>
              {!sugg && !error && <p className="muted"><LoaderCircle size={14} className="spin" /> Analyse des correspondances…</p>}
              {sugg && sugg.keys.length === 0 && (
                <p className="hint-warn"><AlertTriangle size={14} /> Aucune colonne de même nom. Vous pourrez quand même demander à l’agent de relier les tables.</p>
              )}
              {sugg && sugg.keys.length > 0 && (
                <ul>
                  {sugg.keys.map((k) => (
                    <li key={k.column} className={k.uniqueInOther && k.matchShare > 0.5 ? 'good' : undefined}>
                      <code>{k.column}</code>
                      <span>
                        {fmtPct(k.matchShare)} des lignes de « {dataset.name} » trouvent leur correspondance
                        {k.uniqueInOther ? <> · <Check size={12} /> une ligne par valeur dans « {otherMeta?.name} »</> : ' · plusieurs lignes par valeur (à agréger avant de croiser)'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && <p className="hint-warn">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="ghost-btn" onClick={onClose}>Annuler</button>
              <button type="button" className="primary-btn" onClick={save} disabled={!other || !table || saving}>
                {saving ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />} Lier
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
