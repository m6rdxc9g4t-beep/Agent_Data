// Thème clair / sombre / système, commun à la suite Atelier (styles/atelier-brand/atelier-theme.js,
// chargé avant le premier rendu) : la préférence vit dans le cookie atelier_theme sur le VPS, sinon dans
// localStorage « atelier:theme ». Ici, on ne fait que la lire, l'écrire et suivre ses changements.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

interface AtelierTheme {
  get: () => ThemeMode
  set: (pref: ThemeMode) => void
  resolved: () => 'light' | 'dark'
}
declare global {
  interface Window { atelierTheme?: AtelierTheme }
}

const ThemeContext = createContext<{ mode: ThemeMode; dark: boolean; setMode: (m: ThemeMode) => void; print: () => void }>({
  mode: 'system', dark: false, setMode: () => {}, print: () => window.print(),
})

const readMode = (): ThemeMode => window.atelierTheme?.get() ?? 'system'
const readDark = () => (window.atelierTheme?.resolved() ?? document.documentElement.dataset.theme) === 'dark'

/** Pose les deux marqueurs du thème sur <html> (data-theme et classe dark). */
function mark(dark: boolean) {
  const r = document.documentElement
  r.dataset.theme = dark ? 'dark' : 'light'
  r.classList.toggle('dark', dark)
  r.style.colorScheme = dark ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode)
  const [resolvedDark, setResolvedDark] = useState(readDark)
  useEffect(() => {
    const sync = () => { setModeState(readMode()); setResolvedDark(readDark()) }
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    // Le script commun réapplique le thème au changement du système et au retour sur l'onglet : on suit.
    const later = () => setTimeout(sync, 0)
    window.addEventListener('atelier-theme', sync)
    query.addEventListener('change', later)
    document.addEventListener('visibilitychange', later)
    return () => {
      window.removeEventListener('atelier-theme', sync)
      query.removeEventListener('change', later)
      document.removeEventListener('visibilitychange', later)
    }
  }, [])
  // L'impression se fait toujours en clair (graphiques redessinés avant d'ouvrir la boîte d'impression).
  const [printing, setPrinting] = useState(false)
  const dark = !printing && resolvedDark
  useEffect(() => { mark(dark) }, [dark])
  const setMode = (m: ThemeMode) => {
    if (window.atelierTheme) window.atelierTheme.set(m)
    else { setModeState(m); setResolvedDark(m === 'dark' || (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) }
  }
  // Mise en page d'impression appliquée avant d'ouvrir la boîte : les graphiques se redessinent à la largeur de la page.
  const print = () => {
    const root = document.documentElement
    setPrinting(true)
    root.classList.add('printing')
    setTimeout(() => {
      window.print()
      root.classList.remove('printing')
      setPrinting(false)
    }, 600)
  }
  return <ThemeContext.Provider value={{ mode, dark, setMode, print }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
