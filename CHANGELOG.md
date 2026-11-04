# Journal des versions

## 5.0.0 — DataMind (dépôt Agent_Data)

Reprise de *ChatBot_DataAnalyst* v4.2 sous le nom **DataMind**.

### Interface
- Nouvelle interface professionnelle : thèmes clair et sombre natifs (suivent le système),
  typographie Inter, logo, barre latérale structurée (données, moteur, conversation).
- En-tête du jeu de données avec indicateurs : lignes, colonnes, complétude, doublons, score qualité.
- Onglets **Assistant**, **Exploration**, **Qualité** (nouveau) et **Données** (recherche, export CSV).
- Écran d'accueil avec jeux d'exemple en un clic ; analyses rapides en cartes, puis en menu.
- Export du rapport d'analyse en HTML autonome ou en Markdown.

### Agent
- Code réorganisé en package `datamind/` avec une interface commune aux moteurs.
- Claude : modèles 5.5, mise en cache du prompt système et de l'outil, repli sans réflexion,
  messages d'erreur clairs (clé, modèle, débit, réseau).
- Ollama : détection automatique des modèles, délai réglable, `num_ctx`, nouveau repli qui
  exécute le code proposé en bloc ```python``` par les petits modèles.
- Exécution du code : délai maximal, `df` modifiable avec `df_original` intact, graphiques au style unifié.
- Prompt système restructuré (Synthèse / Détails / Points d'attention / Recommandations).

### Données
- CSV français (`;` et virgule décimale), JSON Lines, choix de la feuille Excel,
  conversion automatique des dates, noms de colonnes nettoyés.

### Projet
- Tests pytest (moteurs simulés, interface via `streamlit.testing`), ruff, CI GitHub Actions.
- Image Docker (utilisateur sans privilèges, sonde de santé) et intégration au kit Atelier_Deploy.
