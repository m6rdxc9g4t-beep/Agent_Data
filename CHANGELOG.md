# Journal des versions

## 6.2.1

- Corrige le clignotement à l'ouverture d'un jeu de données : la mise à jour de sa date d'activité
  relançait son chargement en boucle (introduit en 6.2.0).

## 6.2.0 — Historique des jeux de données

- La liste des jeux de données est triée par dernière activité (ouverture ou analyse) ; chaque jeu affiche
  depuis quand on n'y a pas touché. La liste ne bouge pas sous le curseur : le nouvel ordre s'applique au rechargement.
- Recherche dans la liste au-delà de 6 jeux (sans tenir compte des accents ni des majuscules).

## 6.1.0 — Claude avec le forfait

- Nouveau moteur « Claude avec ton forfait » : Claude Agent SDK authentifié par l'abonnement Pro / Max
  (`CLAUDE_CODE_OAUTH_TOKEN`, obtenu avec `claude setup-token`), sans clé API, pour un usage personnel.
  Les outils de DataMind sont exposés par un serveur MCP en mémoire ; les outils intégrés de Claude Code sont désactivés.
- Claude devient le moteur par défaut quand le forfait est configuré.

## 6.0.0 — Web app TypeScript

DataMind abandonne Streamlit pour une web app avec frontend et backend séparés.

- **Backend** Fastify + DuckDB : import des fichiers en Parquet, une base en mémoire verrouillée en lecture
  seule par jeu de données, API REST et réponses de l'agent en flux (SSE).
- **Agent** : l'IA travaille en SQL (DuckDB) au lieu d'exécuter du Python arbitraire, avec des outils dédiés
  pour les graphiques, la segmentation, les modèles prédictifs et la prévision.
- **Frontend** React + Vite : trace numérotée des étapes de l'agent, graphiques interactifs (ECharts),
  onglets Exploration, Qualité et Données (pagination et tri côté serveur), thème clair / sombre.
- **Historique** : jeux de données et analyses conservés sur le serveur (`DATA_DIR`).
- Tests vitest, CI GitHub Actions, image Docker Node.

## 5.0.0 — DataMind (Streamlit)

Reprise de ChatBot_DataAnalyst v4.2 sous le nom DataMind. Remplacée par la 6.0.0.
