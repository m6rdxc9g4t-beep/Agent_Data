// Thème clair / sombre / système, mémorisé dans le navigateur.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

const ThemeContext = createContext<{ mode: ThemeMode; dark: boolean; setMode: (m: ThemeMode) => void }>({
  mode: 'system', dark: false, setMode: () => {},
})

function read(): ThemeMode {
  try {
    const v = localStorage.getItem('datamind:theme')
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(read)
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [systemDark, setSystemDark] = useState(query.matches)
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [query])
  const dark = mode === 'dark' || (mode === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  const setMode = (m: ThemeMode) => {
    setModeState(m)
    try { localStorage.setItem('datamind:theme', m) } catch { /* stockage indisponible */ }
  }
  return <ThemeContext.Provider value={{ mode, dark, setMode }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
