"""DataMind — agent d'analyse de données.

Package métier, indépendant de l'interface :

- ``config``    : réglages lus dans l'environnement.
- ``loader``    : chargement des fichiers (CSV, Excel, JSON, Parquet…) en DataFrame.
- ``executor``  : outil ``run_python`` (exécution réelle du code, capture des figures).
- ``prompts``   : prompt système et catalogue d'analyses rapides.
- ``profiling`` : profil des colonnes, score de qualité, recommandations.
- ``charts``    : graphiques automatiques de l'onglet Exploration.
- ``report``    : export de la conversation (HTML autonome, Markdown).
- ``theme``     : jetons de couleur de l'interface (clair / sombre).
- ``engines``   : boucles agentiques Claude (API Anthropic) et Ollama (local).
"""

__version__ = "5.0.0"
APP_NAME = "DataMind"
