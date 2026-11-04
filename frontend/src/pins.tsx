// Épinglage au tableau de bord : état partagé par les onglets (Assistant, Exploration, Prédiction).
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Pin as PinIcon, PinOff } from 'lucide-react'

import type { ChartSpec, NewPin, Pin, TableData } from './types'

interface PinApi {
  pins: Pin[]
  add: (pin: NewPin) => void
  remove: (key: string) => void
}

export const PinContext = createContext<PinApi | null>(null)
export const usePins = () => useContext(PinContext)

/** Empreinte stable d'un contenu (titre + forme des données) pour reconnaître un élément déjà épinglé. */
export function pinKey(kind: string, title: string, payload: unknown): string {
  const s = JSON.stringify(payload) ?? ''
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return `${kind}:${title.slice(0, 80)}:${(h >>> 0).toString(36)}:${s.length}`
}

export function chartPin(spec: ChartSpec, source: string, sql?: string): NewPin {
  return { key: pinKey('chart', spec.title, spec.data), kind: 'chart', title: spec.title, chart: spec, sql, source }
}
export function tablePin(table: TableData, title: string, source: string, sql?: string): NewPin {
  return { key: pinKey('table', title, table.rows.slice(0, 50)), kind: 'table', title, table, sql, source }
}
export function textPin(text: string, title: string, source: string): NewPin {
  return { key: pinKey('text', title, text), kind: 'text', title, text, source }
}

/** Bouton « Épingler » : bascule l'élément dans le tableau de bord du jeu ouvert. */
export function PinButton({ pin, compact }: { pin: NewPin | null; compact?: boolean }) {
  const ctx = usePins()
  const [flash, setFlash] = useState(false)
  if (!ctx || !pin) return null
  const pinned = ctx.pins.some((p) => p.key === pin.key)
  const toggle = () => {
    if (pinned) ctx.remove(pin.key)
    else { ctx.add(pin); setFlash(true); setTimeout(() => setFlash(false), 1600) }
  }
  return (
    <button type="button" className={`pin-btn${pinned ? ' on' : ''}${compact ? ' compact' : ''}`} onClick={toggle}
      title={pinned ? 'Retirer du tableau de bord' : 'Épingler au tableau de bord'} aria-pressed={pinned}>
      {pinned ? <PinOff size={14} /> : <PinIcon size={14} />}
      {!compact && <span>{flash ? 'Épinglé' : pinned ? 'Épinglé' : 'Épingler'}</span>}
    </button>
  )
}

export function PinProviderValue({ value, children }: { value: PinApi; children: ReactNode }) {
  return <PinContext.Provider value={value}>{children}</PinContext.Provider>
}
