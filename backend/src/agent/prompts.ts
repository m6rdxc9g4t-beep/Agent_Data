// Prompt système de l'agent et catalogue des analyses rapides (partagé avec l'interface via /api/config).

export const SYSTEM_PROMPT = `Tu es DataMind, un analyste de données senior francophone.

L'utilisateur a importé un jeu de données, chargé dans la table DuckDB \`data\`. Tu disposes d'outils :
- run_sql : exécute une requête SQL DuckDB en lecture (SELECT, WITH, SUMMARIZE…) et renvoie le résultat ;
- create_chart : crée un graphique à partir d'une requête SQL (affiché à l'utilisateur) ;
- segment : segmentation k-means ; predict : modèle prédictif évalué sur un jeu de test ; forecast : prévision temporelle.

Méthode
- Tout chiffre que tu avances doit venir d'un outil exécuté sur les données. N'invente jamais de valeur.
- Procède par étapes : explore (run_sql), calcule, vérifie, puis illustre (create_chart) et interprète.
- SQL DuckDB : noms de colonnes entre guillemets doubles ("ma colonne"), fonctions utiles : date_trunc, strftime,
  corr, quantile_cont, median, stddev_samp, regr_slope, count(DISTINCT …), FILTER, QUALIFY, PIVOT, SUMMARIZE data.
  Arrondis les résultats (round(x, 2)). Limite les longues listes (LIMIT 20).
- En cas d'erreur, lis le message, corrige la requête et réessaie.
- Un graphique = une idée, avec un titre explicite. Pour une matrice de corrélation, utilise le type heatmap
  avec trois colonnes (variable_1, variable_2, valeur).

Réponse finale
- En français, en Markdown, concise et structurée : **Synthèse** (2 à 3 phrases avec les chiffres clés),
  **Détails** (liste à puces), **Points d'attention** et, si utile, **Recommandations** concrètes.
- Cite les colonnes entre accents graves (\`colonne\`). Signale les limites (échantillon, valeurs manquantes,
  corrélation n'est pas causalité).
- Si la demande est ambiguë, choisis l'analyse la plus pertinente et précise ton hypothèse au lieu de bloquer.
- Respecte la signification des colonnes indiquée par l'utilisateur (unités, définitions) quand elle est fournie.
- Termine toujours par une section **Pour aller plus loin** : exactement trois questions courtes (une par puce),
  formulées comme l'utilisateur les poserait, qui prolongent l'analyse sur ces données.`

export interface QuickAnalysis {
  key: string
  group: string
  label: string
  icon: string
  summary: string
  prompt: string
}

const q = (group: string, key: string, label: string, icon: string, summary: string, prompt: string): QuickAnalysis =>
  ({ key, group, label, icon, summary, prompt })

export const QUICK_ANALYSES: QuickAnalysis[] = [
  q('Comprendre', 'overview', "Vue d'ensemble", 'telescope', 'Structure, granularité et premiers constats',
    "Fais une vue d'ensemble du jeu de données : ce qu'il décrit, ce que représente une ligne, la période couverte s'il y a des dates, et les 3 premiers constats qui ressortent, avec un graphique."),
  q('Comprendre', 'describe', 'Statistiques descriptives', 'sigma', 'Moyennes, médianes, dispersion, fréquences',
    'Calcule les statistiques descriptives : moyenne, médiane, écart-type, min, max et quartiles pour les variables numériques ; fréquences des modalités pour les catégorielles. Commente les résultats notables.'),
  q('Comprendre', 'distributions', 'Distributions', 'chart-column', 'Forme, asymétrie, valeurs typiques',
    'Analyse la distribution des principales variables numériques (histogrammes) et indique si elles sont symétriques, asymétriques ou multimodales.'),
  q('Qualité', 'quality', 'Audit qualité', 'shield-check', 'Doublons, incohérences, plan de nettoyage',
    'Évalue la qualité des données : doublons, valeurs manquantes, incohérences, valeurs improbables, cardinalité des catégories. Termine par un plan de nettoyage priorisé.'),
  q('Qualité', 'missing', 'Valeurs manquantes', 'grid-2x2-x', 'Volume, motifs et traitements',
    'Analyse les valeurs manquantes (nombre et pourcentage par colonne, colonnes souvent vides ensemble) et propose une stratégie de traitement pour chaque colonne concernée.'),
  q('Qualité', 'outliers', 'Valeurs aberrantes', 'scatter-chart', 'Détection par écart interquartile',
    "Identifie les valeurs aberrantes des colonnes numériques avec la méthode de l'écart interquartile (IQR), illustre les plus marquantes et discute si elles semblent légitimes."),
  q('Analyser', 'correlations', 'Corrélations', 'network', 'Matrice et relations fortes',
    'Calcule les corrélations entre variables numériques, affiche la matrice en heatmap et commente les relations les plus fortes, positives et négatives, sans conclure à la causalité.'),
  q('Analyser', 'segments', 'Segmentation', 'boxes', 'Groupes homogènes et leurs profils',
    'Segmente les données en groupes homogènes avec l\'outil segment, puis décris le profil de chaque segment et ce qui les distingue.'),
  q('Analyser', 'trends', 'Tendances temporelles', 'trending-up', 'Évolution, saisonnalité, ruptures',
    "S'il existe une colonne de date, analyse l'évolution des principaux indicateurs dans le temps (agrégation mensuelle, saisonnalité, ruptures) avec des graphiques."),
  q('Prédire', 'forecast', 'Prévision', 'chart-spline', 'Projection des prochaines périodes',
    "Prévois l'évolution de l'indicateur principal sur les 6 prochaines périodes avec l'outil forecast, puis commente la tendance et la fiabilité de la prévision."),
  q('Prédire', 'model', 'Modèle prédictif', 'brain-circuit', 'Cible, entraînement, évaluation',
    "Identifie la variable cible la plus pertinente, entraîne un modèle avec l'outil predict et explique sa qualité par rapport à la baseline."),
  q('Prédire', 'drivers', "Facteurs d'influence", 'gauge', 'Ce qui fait varier la cible',
    "Identifie la variable cible la plus pertinente puis les facteurs qui l'influencent le plus (outil predict), et interprète-les concrètement."),
  q('Restituer', 'insights', '5 enseignements clés', 'lightbulb', 'Les constats chiffrés à retenir',
    'Dégage les 5 enseignements les plus importants de ce jeu de données, chacun appuyé par des chiffres précis et, si utile, un graphique.'),
  q('Restituer', 'kpis', 'Tableau de bord', 'layout-dashboard', 'Indicateurs clés et graphiques',
    "Construis un mini tableau de bord : les indicateurs clés à suivre, leur valeur et leur évolution, avec quelques graphiques de synthèse."),
  q('Restituer', 'business', 'Questions métier', 'briefcase', 'Ce que ces données permettent de décider',
    'Quelles questions métier concrètes ces données permettent-elles de traiter ? Réponds aux trois plus utiles, chiffres à l\'appui, et termine par des recommandations.'),
]

export const FEATURED = ['overview', 'quality', 'insights', 'correlations', 'trends', 'model']
