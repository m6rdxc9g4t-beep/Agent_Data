// Marque de la suite Atelier (icône carrée en dégradé de la signature + « Atelier DataMind ») et fenêtre « À propos ».
import { useRef } from 'react'
import { Sparkles, X } from 'lucide-react'

export function Brand({ instanceLabel, version }: { instanceLabel?: string; version?: string }) {
  const about = useRef<HTMLDialogElement>(null)
  return (
    <>
      <button type="button" className="atelier-brand" aria-haspopup="dialog" onClick={() => about.current?.showModal()}
        title={instanceLabel || 'À propos de DataMind'}>
        <span className="atelier-brand__tile" aria-hidden><Sparkles /></span>
        <span className="atelier-brand__name"><span className="atelier-brand__prefix">Atelier </span>DataMind</span>
      </button>
      <dialog ref={about} className="atelier-about" aria-labelledby="about-title"
        onClick={(e) => { if (e.target === e.currentTarget) about.current?.close() }}>
        <div className="atelier-about__panel">
          <button type="button" className="atelier-about__close" aria-label="Fermer" onClick={() => about.current?.close()}><X size={16} /></button>
          <span className="atelier-about__icon atelier-brand__tile" aria-hidden><Sparkles /></span>
          <h2 id="about-title" className="atelier-about__name"><span className="atelier-brand__prefix">Atelier </span>DataMind</h2>
          <p className="atelier-about__tagline">Agent d’analyse de données</p>
          <p className="atelier-about__suite">{instanceLabel || 'Suite Atelier'}{version && <> · v{version}</>}</p>
        </div>
      </dialog>
    </>
  )
}

/** Icône de l'app seule (barre du haut sur téléphone). */
export function BrandTile() {
  return <span className="atelier-brand__tile atelier-brand__tile--sm" aria-hidden><Sparkles /></span>
}
