// Démo publique : contexte lu par les composants qui masquent les fonctions d'écriture (import, nettoyage, liens…).
import { createContext, useContext } from 'react'

export const DemoContext = createContext(false)

/** Vrai sur une instance de démo publique (DATAMIND_DEMO=1). */
export const useDemo = () => useContext(DemoContext)
