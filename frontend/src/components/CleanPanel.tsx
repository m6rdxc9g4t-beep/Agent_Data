// Nettoyage appliqué : étapes proposées d'après le profil, appliquées dans une nouvelle version du jeu.
import { useEffect, useState } from 'react'
import { ArrowRight, Check, LoaderCircle, Sparkles } from 'lucide-react'

import { api } from '../api'
import type { DatasetDetail, DatasetMeta, PlannedStep } from '../types'

function Inline({ text }: { text: string }) {
  return <>{text.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>
}

export function CleanPanel({ dataset, onCreated, onOpen }: {
  dataset: DatasetDetail; onCreated: (meta: DatasetMeta) => void; onOpen: (id: string) => void
}) {
  const [plan, setPlan] = useState<PlannedStep[] | null>(null)
  const [on, setOn] = useState<Record<string, boolean>>({})
  const [cols, setCols] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ dataset: DatasetMeta; report: string[] } | null>(null)

  useEffect(() => {
    setPlan(null); setDone(null); setError(null)
    api.cleanPlan(dataset.id).then((p) => {
      setPlan(p)
      setOn(Object.fromEntries(p.map((s) => [s.kind, s.recommended])))
      setCols(Object.fromEntries(p.map((s) => [s.kind, s.columns])))
    }).catch((e: Error) => setError(e.message))
  }, [dataset.id])

  if (!plan && !error) return null
  const toggleCol = (kind: string, c: string) =>
    setCols((m) => ({ ...m, [kind]: m[kind].includes(c) ? m[kind].filter((x) => x !== c) : [...m[kind], c] }))
  const chosen = (plan ?? []).filter((s) => on[s.kind] && (s.kind === 'dedupe' || cols[s.kind]?.length))
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.clean(dataset.id, chosen.map((s) => ({ kind: s.kind, columns: s.kind === 'dedupe' ? [] : cols[s.kind] })))
      setDone(r)
      onCreated(r.dataset)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section clean">
      <div className="section-head">
        <h2 className="section-title">Nettoyer les données</h2>
        {plan && plan.length > 0 && !done && <span className="muted small">L’original est conservé : le résultat devient un nouveau jeu de données.</span>}
      </div>
      {plan && plan.length === 0 && <p className="clean-ok"><Check size={16} /> Rien à nettoyer automatiquement : pas de doublon, d’espace parasite ni de colonne vide.</p>}
      {plan && plan.length > 0 && !done && (
        <>
          <ul className="clean-steps">
            {plan.map((s) => (
              <li key={s.kind} className={on[s.kind] ? 'on' : undefined}>
                <label className="clean-check">
                  <input type="checkbox" checked={!!on[s.kind]} onChange={(e) => setOn({ ...on, [s.kind]: e.target.checked })} />
                  <span>
                    <strong>{s.title}</strong>{!s.recommended && <span className="tag">à vérifier</span>}
                    <small>{s.detail}</small>
                  </span>
                </label>
                {s.columns.length > 0 && (
                  <div className="clean-cols">
                    {s.columns.map((c) => (
                      <button key={c} type="button" disabled={!on[s.kind]} aria-pressed={cols[s.kind]?.includes(c)}
                        className={cols[s.kind]?.includes(c) ? 'on' : undefined} onClick={() => toggleCol(s.kind, c)}>
                        <code>{c}</code>{s.columnNotes[c] && <span>{s.columnNotes[c]}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="primary-btn" onClick={apply} disabled={busy || !chosen.length}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            Créer une version nettoyée{chosen.length > 0 && ` (${chosen.length} étape${chosen.length > 1 ? 's' : ''})`}
          </button>
        </>
      )}
      {error && <p className="hint-warn">{error}</p>}
      {done && (
        <div className="clean-done">
          <p><Check size={16} /> <strong>« {done.dataset.name} » créé</strong> ({done.dataset.rows.toLocaleString('fr-FR')} lignes, {done.dataset.columns.length} colonnes).</p>
          <ul>{done.report.map((r, i) => <li key={i}><Inline text={r} /></li>)}</ul>
          <button type="button" className="primary-btn" onClick={() => onOpen(done.dataset.id)}>Ouvrir la version nettoyée <ArrowRight size={15} /></button>
        </div>
      )}
    </section>
  )
}
