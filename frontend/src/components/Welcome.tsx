// Écran d'accueil : importer un fichier ou partir d'un jeu d'exemple.
import { useRef } from 'react'
import { Upload } from 'lucide-react'

import type { Sample } from '../types'
import { SampleGallery } from './SampleGallery'

export function Welcome({ samples, formats, maxUploadMb, onUpload, onSample, busy, busyFile }: {
  samples: Sample[]
  formats: string[]
  maxUploadMb: number
  onUpload: (f: File) => void
  onSample: (s: Sample) => void
  busy: boolean
  busyFile: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Posez vos questions à vos données.</h1>
        <p className="lede">
          DataMind lit votre fichier, écrit les requêtes SQL et les calculs nécessaires, les exécute réellement et vous répond
          avec des chiffres vérifiables, des graphiques et chaque étape de son raisonnement.
        </p>

        <button type="button" className="dropzone" onClick={() => input.current?.click()} disabled={busy}>
          <Upload size={22} />
          <strong>Choisir un fichier ou le déposer ici</strong>
          <span>CSV, Excel, JSON ou Parquet, jusqu’à {maxUploadMb} Mo</span>
        </button>
        <input ref={input} type="file" hidden accept={formats.join(',')} onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />

        <section className="samples">
          <h2>Ou partez d’un exemple</h2>
          <SampleGallery samples={samples} onPick={onSample} busyFile={busyFile} />
        </section>

        <dl className="how">
          <div><dt>Vos fichiers restent sur le serveur</dt><dd>Les données sont stockées sur ce serveur et interrogées sur place, en lecture seule.</dd></div>
          <div><dt>Chaque chiffre est calculé</dt><dd>L’agent n’avance rien sans l’avoir obtenu par une requête que vous pouvez relire.</dd></div>
          <div><dt>Deux moteurs</dt><dd>Ollama, l’IA du serveur, gratuite ; ou Claude pour les analyses les plus exigeantes.</dd></div>
        </dl>
      </div>
    </div>
  )
}
