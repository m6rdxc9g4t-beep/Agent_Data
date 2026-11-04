"""Prompt système et catalogue d'analyses rapides."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

SYSTEM_PROMPT = """Tu es DataMind, un analyste de données senior francophone.

L'utilisateur a importé un jeu de données : il est chargé dans le DataFrame pandas `df` \
(une copie intacte est dans `df_original`). Tu disposes de l'outil `run_python` pour \
exécuter du code sur ces données.

Méthode
- Tout chiffre que tu avances (statistique, comptage, corrélation, score, prévision) \
doit venir d'un calcul fait avec `run_python` sur les données réelles. N'invente jamais \
de valeur.
- Procède par étapes : inspecte, calcule, vérifie, puis interprète. Si une étape échoue, \
lis le traceback, corrige et relance.
- Pour la modélisation (prévision, scoring, clustering), utilise scikit-learn avec des \
modèles simples et robustes, une découpe train/test et des métriques adaptées, comparées \
à une baseline naïve.
- Pour un graphique, une figure matplotlib/seaborn claire : titre, axes nommés, unités. \
Une idée par graphique.
- Ne réaffiche pas de longs tableaux bruts : résume (top 10, agrégats).

Réponse finale
- En français, structurée et concise, au format Markdown :
  **Synthèse** (2 à 3 phrases avec les chiffres clés), puis **Détails** (liste à puces), \
puis **Points d'attention** et, si utile, **Recommandations** concrètes.
- Cite les colonnes concernées entre accents graves (`colonne`).
- Signale les limites (taille d'échantillon, valeurs manquantes, causalité non démontrée).
- Si la question est ambiguë, choisis l'analyse la plus pertinente et précise ton hypothèse \
au lieu de bloquer.
"""


def dataset_overview(df: pd.DataFrame, max_cols: int = 60) -> str:
    """Résumé compact du DataFrame, injecté dans le prompt système."""
    lines = [f"Dimensions : {df.shape[0]} lignes × {df.shape[1]} colonnes", "", "Colonnes :"]
    for col in list(df.columns)[:max_cols]:
        s = df[col]
        missing = int(s.isna().sum())
        detail = f"{s.nunique(dropna=True)} valeurs distinctes"
        if pd.api.types.is_numeric_dtype(s) and s.notna().any():
            detail += f", min {s.min():.4g}, max {s.max():.4g}"
        elif pd.api.types.is_datetime64_any_dtype(s) and s.notna().any():
            detail += f", du {s.min():%Y-%m-%d} au {s.max():%Y-%m-%d}"
        lines.append(f"  - {col} ({s.dtype}) — {detail}, {missing} manquante(s)")
    if df.shape[1] > max_cols:
        lines.append(f"  … et {df.shape[1] - max_cols} autres colonnes.")
    lines += ["", "Aperçu (5 premières lignes) :"]
    with pd.option_context("display.max_columns", max_cols, "display.width", 1000):
        lines.append(df.head().to_string())
    return "\n".join(lines)


def build_system_prompt(df: pd.DataFrame | None, name: str | None = None) -> str:
    if df is None:
        return SYSTEM_PROMPT + "\n\nAucun jeu de données n'est encore chargé."
    title = f" « {name} »" if name else ""
    return f"{SYSTEM_PROMPT}\n\n--- JEU DE DONNÉES{title} ---\n{dataset_overview(df)}"


# --------------------------------------------------------------------------- #
# Analyses rapides
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class QuickAnalysis:
    key: str
    label: str
    icon: str  # icône Material de Streamlit
    summary: str
    prompt: str


QUICK_GROUPS: list[tuple[str, list[QuickAnalysis]]] = [
    ("Comprendre", [
        QuickAnalysis(
            "overview", "Vue d'ensemble", ":material/travel_explore:",
            "Structure, types et premiers constats",
            "Fais une vue d'ensemble du jeu de données : ce qu'il décrit, la granularité "
            "d'une ligne, les types de colonnes, la période couverte s'il y a des dates, et "
            "les 3 premiers constats qui ressortent.",
        ),
        QuickAnalysis(
            "describe", "Statistiques descriptives", ":material/functions:",
            "Moyennes, médianes, dispersion, fréquences",
            "Calcule les statistiques descriptives : moyenne, médiane, écart-type, min, max "
            "et quartiles pour les variables numériques ; fréquences des modalités pour les "
            "catégorielles. Commente les résultats les plus notables.",
        ),
        QuickAnalysis(
            "distributions", "Distributions", ":material/bar_chart:",
            "Forme, asymétrie, multimodalité",
            "Analyse la distribution de chaque variable numérique (histogrammes, asymétrie, "
            "aplatissement) et indique si elles sont normales, asymétriques ou multimodales.",
        ),
    ]),
    ("Qualité", [
        QuickAnalysis(
            "quality", "Audit qualité", ":material/verified:",
            "Doublons, incohérences, plan de nettoyage",
            "Évalue la qualité des données : doublons, valeurs manquantes, incohérences, "
            "valeurs improbables, cardinalité des catégories. Termine par un plan de "
            "nettoyage priorisé.",
        ),
        QuickAnalysis(
            "missing", "Valeurs manquantes", ":material/grid_off:",
            "Volume, motifs et traitements",
            "Analyse les valeurs manquantes (nombre et pourcentage par colonne, motifs de "
            "co-absence) et propose une stratégie de traitement adaptée à chaque colonne.",
        ),
        QuickAnalysis(
            "outliers", "Valeurs aberrantes", ":material/scatter_plot:",
            "Détection IQR et boxplots",
            "Identifie les valeurs aberrantes de chaque colonne numérique avec la méthode "
            "de l'écart interquartile (IQR), montre-les en boxplots et discute si elles "
            "semblent légitimes.",
        ),
    ]),
    ("Analyser", [
        QuickAnalysis(
            "correlations", "Corrélations", ":material/hub:",
            "Matrice et relations fortes",
            "Calcule la matrice de corrélation des variables numériques, affiche-la en "
            "heatmap annotée et commente les corrélations les plus fortes, positives et "
            "négatives, sans conclure à la causalité.",
        ),
        QuickAnalysis(
            "segments", "Segmentation", ":material/bubble_chart:",
            "Clustering K-Means et profils",
            "Segmente les données en groupes homogènes avec K-Means (variables normalisées, "
            "nombre de clusters justifié par le score silhouette), puis décris le profil de "
            "chaque segment.",
        ),
        QuickAnalysis(
            "trends", "Tendances temporelles", ":material/timeline:",
            "Évolution, saisonnalité, ruptures",
            "S'il existe une colonne de date, analyse l'évolution des principaux indicateurs "
            "dans le temps (agrégation mensuelle, saisonnalité, ruptures) avec des graphiques.",
        ),
    ]),
    ("Prédire", [
        QuickAnalysis(
            "forecast", "Prévision", ":material/query_stats:",
            "Projection des prochaines périodes",
            "Construis une prévision de la principale variable numérique : agrège par période, "
            "entraîne un modèle simple sur le temps, trace l'historique et la prévision des 3 à "
            "6 prochaines périodes, et commente la fiabilité.",
        ),
        QuickAnalysis(
            "model", "Modèle prédictif", ":material/model_training:",
            "Cible, entraînement et évaluation",
            "Identifie la variable cible la plus pertinente, prépare les variables (encodage, "
            "manquants), entraîne un modèle scikit-learn adapté et évalue-le sur un jeu de test "
            "contre une baseline naïve (R²/MAE ou accuracy/précision/rappel/F1).",
        ),
        QuickAnalysis(
            "drivers", "Facteurs d'influence", ":material/insights:",
            "Importance des variables",
            "Entraîne une forêt aléatoire sur la cible la plus pertinente, calcule l'importance "
            "des variables (par permutation), présente-la en graphique et interprète les "
            "facteurs les plus influents.",
        ),
    ]),
    ("Restituer", [
        QuickAnalysis(
            "insights", "5 enseignements clés", ":material/lightbulb:",
            "Les constats chiffrés à retenir",
            "Dégage les 5 enseignements les plus importants de ce jeu de données, chacun appuyé "
            "par des chiffres précis et, si utile, un graphique.",
        ),
        QuickAnalysis(
            "kpis", "Tableau de bord", ":material/dashboard:",
            "Indicateurs clés et graphiques",
            "Construis un mini tableau de bord : les indicateurs clés à suivre pour ces données, "
            "leur valeur actuelle et leur évolution, avec quelques graphiques de synthèse.",
        ),
        QuickAnalysis(
            "business", "Questions métier", ":material/business_center:",
            "Ce que ces données permettent de décider",
            "Quelles questions métier concrètes ces données permettent-elles de traiter ? "
            "Réponds aux trois plus utiles, chiffres à l'appui, et termine par des "
            "recommandations.",
        ),
    ]),
]

ALL_ANALYSES: dict[str, QuickAnalysis] = {a.key: a for _, items in QUICK_GROUPS for a in items}

# Analyses mises en avant sur l'écran d'accueil de l'assistant.
FEATURED = ["overview", "quality", "insights", "correlations", "trends", "model"]
