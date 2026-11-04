// Point d'entrée : démarre l'API (et sert l'interface compilée si STATIC_DIR est défini).
import { buildApp } from './app.js'
import { config } from './config.js'

const app = await buildApp()
await app.listen({ host: config.host, port: config.port })
console.log(`DataMind ${config.version} — http://${config.host}:${config.port} (données : ${config.dataDir})`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0))
  })
}
