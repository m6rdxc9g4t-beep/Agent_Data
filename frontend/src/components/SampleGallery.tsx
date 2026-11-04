// Galerie des jeux d'exemple, filtrable par domaine : sur l'accueil et dans une fenêtre ouverte depuis la barre latérale.
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, LoaderCircle, X } from 'lucide-react'

import { fmtInt } from '../format'
import type { Sample } from '../types'

export function SampleGallery({ samples, onPick, busyFile }: { samples: Sample[]; onPick: (s: Sample) => void; busyFile: string | null }) {
  const domains = useMemo(() => [...new Set(samples.map((s) => s.domain))], [samples])
  const [domain, setDomain] = useState<string | null>(null)
  const shown = domain ? samples.filter((s) => s.domain === domain) : samples

  return (
    <div className="gallery">
      <div className="chips" role="radiogroup" aria-label="Domaine">
        <button type="button" role="radio" aria-checked={domain === null} className={domain === null ? 'on' : ''} onClick={() => setDomain(null)}>
          Tous <span>{samples.length}</span>
        </button>
        {domains.map((d) => (
          <button key={d} type="button" role="radio" aria-checked={domain === d} className={domain === d ? 'on' : ''} onClick={() => setDomain(d)}>
            {d} <span>{samples.filter((s) => s.domain === d).length}</span>
          </button>
        ))}
      </div>
      <div className="sample-grid">
        {shown.map((s) => (
          <button key={s.file} type="button" className="sample-card" onClick={() => onPick(s)} disabled={!!busyFile}>
            <span className="sample-domain">{s.domain}</span>
            <strong>{s.label}</strong>
            <span className="sample-desc">{s.description}</span>
            {s.ideas[0] && <span className="sample-idea">Par exemple : {s.ideas[0]}</span>}
            <span className="sample-foot">
              <span>{fmtInt(s.rows)} lignes, {s.columns} colonnes</span>
              <span className="sample-action">
                {busyFile === s.file ? <><LoaderCircle size={14} className="spin" /> Import…</>
                  : s.datasetId ? <><Check size={14} /> Ouvrir</> : <>Charger <ArrowRight size={14} /></>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function SampleDialog({ samples, onPick, onClose, busyFile }: {
  samples: Sample[]; onPick: (s: Sample) => void; onClose: () => void; busyFile: string | null
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="samples-title">
        <header>
          <div>
            <h2 id="samples-title">Jeux d’exemple</h2>
            <p>Des données fictives mais réalistes, pour essayer l’assistant, l’exploration et la prédiction.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>
        <SampleGallery samples={samples} onPick={onPick} busyFile={busyFile} />
      </div>
    </div>
  )
}
