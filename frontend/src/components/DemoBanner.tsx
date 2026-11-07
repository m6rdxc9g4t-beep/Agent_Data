// Bandeau discret de la démo publique : ce qu'on peut faire ici, et le retour au portfolio.
import { ArrowUpRight } from 'lucide-react'

export function DemoBanner({ returnUrl }: { returnUrl: string | null }) {
  return (
    <div className="demo-banner" role="note">
      <p>
        <span><strong>Démo publique</strong><span className="demo-sep" aria-hidden> · </span>jeux d’exemple</span>
        <span className="demo-sep demo-sep--wide" aria-hidden> · </span>
        <span>IA du serveur, peut prendre une minute</span>
      </p>
      {returnUrl && <a className="demo-back" href={returnUrl}>Portfolio <ArrowUpRight size={13} aria-hidden /></a>}
    </div>
  )
}
