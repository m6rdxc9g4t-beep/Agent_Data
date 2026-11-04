# Journal des versions

## 6.4.0 — Jeux d'exemple dans 9 domaines

- 15 jeux d'exemple fictifs mais réalistes : commerce, finance (transactions et fraude, crédit, bourse),
  marketing (campagnes, newsletter, fidélité), IA & tech (expériences de machine learning, usage d'une API d'IA),
  RH, énergie, santé, immobilier et logistique. Chacun contient de vrais effets à découvrir et une cible à prédire.
- Bouton « Jeux d'exemple » dans la barre latérale : la galerie, filtrable par domaine, est accessible à tout moment,
  plus seulement à l'accueil. Un exemple déjà chargé s'ouvre directement au lieu d'être réimporté.
- L'Assistant propose des questions adaptées à chaque jeu d'exemple.
- Catalogue `sample_data/catalog.json` ; les données sont régénérables avec `python3 scripts/generer_exemples.py`.

## 6.3.0 — Onglet Prédiction

- **Prévoir une variable** : entraîne et compare quatre modèles (référence naïve, régression linéaire ou
  logistique, gradient boosting d'arbres, réseau de neurones) sur un jeu de test jamais vu ; tableau des scores,
  valeurs réelles contre prédites ou matrice de confusion, influence des variables (par permutation) et
  simulateur pour tester le modèle retenu. Cible numérique, oui / non ou catégorie de 10 modalités au plus.
- **Prévoir dans le temps** : compare référence naïve, tendance + saisonnalité, Holt-Winters et réseau de
  neurones autorégressif sur les dernières périodes, puis projette avec le meilleur (intervalle indicatif, export CSV).
- Modèles écrits en TypeScript (pas de dépendance lourde) ; fonctionne sans moteur IA.
- « Faire commenter par l'agent » envoie les résultats à l'Assistant.
- Les outils `predict` et `forecast` de l'agent utilisent ces mêmes modèles.

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
