// Point d'entrée : démarre l'API (et sert l'interface compilée si STATIC_DIR est défini).
import { buildApp } from './app.js'
import { config } from './config.js'

if (config.demo) {
  // Démo publique : le jeton du forfait Claude et la clé API ne doivent être lisibles par aucun sous-processus.
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'DATAMIND_CLAUDE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[name]
}

const app = await buildApp()
await app.listen({ host: config.host, port: config.port })
console.log(`DataMind ${config.version}${config.demo ? ' (démo publique)' : ''} — http://${config.host}:${config.port} (données : ${config.dataDir})`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0))
  })
}
