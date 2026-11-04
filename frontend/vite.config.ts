import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// En développement, l'API (backend Fastify) tourne sur le port 3600.
export default defineConfig({
  plugins: [react()],
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
