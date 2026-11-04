# Journal des versions

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
