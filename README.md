# DataMind

**Agent d'analyse de données.** Importez un fichier, posez vos questions en français :
DataMind écrit des requêtes SQL, les **exécute réellement sur vos données** (DuckDB) et vous répond
avec des chiffres vérifiables, des graphiques et la trace de chaque étape.

Web app TypeScript : backend **Fastify + DuckDB**, frontend **React + Vite**, un seul processus en production.

![Assistant](docs/screenshots/assistant.png)

| Exploration automatique | Qualité des données |
|---|---|
| ![Exploration](docs/screenshots/exploration.png) | ![Qualité](docs/screenshots/qualite.png) |

## Fonctionnalités

- **Assistant** — l'agent dispose de cinq outils : `run_sql` (requête en lecture seule sur la table `data`),
  `create_chart` (graphique interactif), `segment` (k-means), `predict` (régression linéaire ou logistique,
  évaluée sur un jeu de test contre une baseline) et `forecast` (tendance + saisonnalité). Chaque étape
  s'affiche dans une trace numérotée : requête SQL, résultat, graphique. 15 analyses en un clic.
- **Prédiction** — apprentissage automatique sans code. *Prévoir une variable* : quatre modèles comparés sur un
  jeu de test (référence naïve, régression linéaire ou logistique, gradient boosting d'arbres, réseau de neurones),
  influence des variables et simulateur. *Prévoir dans le temps* : référence naïve, tendance + saisonnalité,
  Holt-Winters et réseau de neurones autorégressif, le meilleur prolonge la série. Fonctionne sans moteur IA.
- **Exploration** — graphiques automatiques (évolution, comparaison, répartition, distribution) et
  exploration colonne par colonne, sans IA.
- **Qualité** — score sur 100, profil de chaque colonne, recommandations de nettoyage.
- **Données** — table paginée côté serveur, recherche, tri, export CSV au format français.
- **Historique** — jeux de données et analyses enregistrés sur le serveur ; export d'une analyse en page HTML.
- **Fichiers** — CSV / TSV (encodage et séparateur détectés, format français `;` et virgule décimale),
  Excel (choix de la feuille), JSON, JSON Lines, Parquet ; jusqu'à 200 Mo.
- **Thème** clair, sombre ou celui du système.

## Moteurs IA

| Moteur | Coût | Clé | Remarques |
|---|---|---|---|
| **Ollama** (défaut) | Gratuit | Aucune | Le modèle doit gérer les outils : `llama3.1`, `llama3.2`, `qwen2.5`, `mistral-nemo`. |
| **Claude avec ton forfait** | Inclus dans Pro / Max | Aucune : jeton `CLAUDE_CODE_OAUTH_TOKEN` | Via le Claude Agent SDK, pour un usage personnel ; consomme les limites de l'abonnement. |
| **Claude avec une clé API** | À l'usage | `ANTHROPIC_API_KEY` sur le serveur, ou saisie dans l'interface (session) | `claude-sonnet-5-5` par défaut ; Opus 5.5 et Haiku 5.5 au choix. |

**Forfait Claude sans clé API** : sur une machine avec navigateur, lance `claude setup-token` (Claude Code,
connecté à ton compte Pro ou Max), puis renseigne le jeton obtenu dans `CLAUDE_CODE_OAUTH_TOKEN` sur le serveur.
DataMind passe alors par le Claude Agent SDK avec tes outils uniquement (fichiers, commandes et web de Claude Code
désactivés). Cet usage est prévu pour toi seul : n'ouvre pas une instance configurée ainsi à d'autres personnes.

Pour les petits modèles locaux, DataMind rattrape aussi un appel d'outil écrit en JSON dans le texte
et exécute une requête proposée dans un bloc ` ```sql `, puis renvoie le vrai résultat au modèle.

## Démarrage

```bash
git clone https://github.com/m6rdxc9g4t-beep/Agent_Data.git
cd Agent_Data
npm install
npm run dev          # API sur :3600, interface sur http://localhost:5173
```

Production :

```bash
npm run build
STATIC_DIR=frontend/dist npm start      # http://127.0.0.1:3600
```

Docker :

```bash
docker build -t datamind .
docker run -p 3600:3600 -v datamind:/data -e OLLAMA_URL=http://host.docker.internal:11434 datamind
```

### Sur le VPS (suite Atelier)

DataMind est intégré au kit [Atelier_Deploy](https://github.com/m6rdxc9g4t-beep/Atelier_Deploy) :
`https://datamind.<domaine>`, derrière la connexion du portail, avec l'Ollama du serveur.

```bash
cd ~/Ateliers/Atelier_Deploy && sudo ./update.sh datamind
```

## Configuration

Variables d'environnement, toutes facultatives (voir [`.env.example`](.env.example)) :

| Variable | Défaut | Rôle |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3600` | Adresse d'écoute |
| `DATA_DIR` | `./data` | Jeux de données (Parquet) et analyses (JSON) |
| `STATIC_DIR` | — | Interface compilée servie par le backend |
| `MAX_UPLOAD_MB` | `200` | Taille maximale d'un fichier |
| `DATAMIND_ENGINE` | auto | Moteur proposé par défaut (Claude si le forfait est configuré) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Serveur Ollama |
| `OLLAMA_MODEL` | `llama3.1` | Modèle Ollama préféré |
| `OLLAMA_TIMEOUT` | `600` | Délai d'une réponse (s) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Jeton du forfait Claude (`claude setup-token`), prioritaire sur la clé API |
| `ANTHROPIC_API_KEY` | — | Clé Claude côté serveur |
| `DATAMIND_CLAUDE_MODEL` | `claude-sonnet-5-5` | Modèle Claude par défaut |
| `DATAMIND_MAX_STEPS` | `12` | Allers-retours modèle ↔ outils par question |
| `DATAMIND_QUERY_TIMEOUT` | `60` | Durée maximale d'une requête (s) |
| `DATAMIND_INSTANCE_LABEL` | — | Libellé sous le nom de l'app |

## Architecture

```
backend/src/
├── server.ts          Démarrage
├── app.ts             API REST + réponses de l'agent en flux (SSE), sert l'interface
├── importer.ts        Fichier → Parquet (encodage, séparateur, feuilles Excel)
├── db.ts              DuckDB en mémoire par jeu de données, verrouillé en lecture seule
├── profile.ts         Profil des colonnes, score de qualité, recommandations
├── charts.ts          Graphiques de l'agent et graphiques automatiques
├── analysis.ts        k-means
├── ml/                Apprentissage : préparation, gradient boosting, réseau de neurones, séries temporelles
├── store.ts           Métadonnées et analyses en fichiers JSON
└── agent/
    ├── prompts.ts     Prompt système, catalogue des analyses rapides
    ├── tools.ts       Outils de l'agent (schémas + exécution)
    ├── engines.ts     Boucles Claude (clé API) et Ollama
    └── claude-plan.ts Claude avec le forfait (Agent SDK, outils exposés par MCP)
frontend/src/
├── App.tsx            État de l'application, envoi des questions, lecture du flux
├── components/        Barre latérale, accueil, Assistant, Exploration, Qualité, Données, graphiques (ECharts)
└── styles.css         Thème clair / sombre
```

**Sécurité des requêtes** : chaque jeu de données est chargé dans une base DuckDB en mémoire, puis l'accès
aux fichiers est coupé (`enable_external_access = false`) et la configuration verrouillée. Seules les
instructions de lecture sont acceptées, une à la fois, avec un délai maximal. Aucun code arbitraire n'est
exécuté. L'app n'a pas de connexion propre : sur un serveur, placez-la derrière une authentification
(c'est le rôle du portail dans la suite Atelier).

## Développement

```bash
npm run typecheck
npm test             # vitest : import, requêtes, analyses, moteurs simulés, API
```
