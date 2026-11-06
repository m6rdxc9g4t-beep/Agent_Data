import { readFileSync } from 'node:fs'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Préférence de thème commune à la suite Atelier : `atelier-theme.js` (copie verbatim de
 * Atelier_Projets/design-system/brand/) est recopié en script bloquant au tout début de <head>, pour poser
 * le thème avant le premier affichage, en développement comme dans l'interface compilée.
 * Avant lui, reprise unique de l'ancienne clé `datamind:theme`.
 */
function atelierTheme(): Plugin {
  const file = new URL('./src/styles/atelier-brand/atelier-theme.js', import.meta.url)
  const migrate =
    'try{var o=localStorage.getItem("datamind:theme");if((o==="light"||o==="dark"||o==="system")&&!localStorage.getItem("atelier:theme"))localStorage.setItem("atelier:theme",o);localStorage.removeItem("datamind:theme")}catch(e){}'
  return {
    name: 'atelier-theme',
    transformIndexHtml: () => [{ tag: 'script', children: `${migrate}\n${readFileSync(file, 'utf8')}`, injectTo: 'head-prepend' }],
  }
}

// En développement, l'API (backend Fastify) tourne sur le port 3600.
export default defineConfig({
  plugins: [atelierTheme(), react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3600', changeOrigin: false } },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('echarts') || id.includes('zrender')) return 'charts'
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark') || id.includes('mdast')) return 'markdown'
        },
      },
    },
  },
})
