"""Profil du jeu de données : types, complétude, score de qualité, recommandations.

Calculé localement, sans IA : l'onglet Qualité s'affiche instantanément.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

KIND_LABELS = {
    "numeric": "Numérique",
    "datetime": "Date",
    "boolean": "Booléen",
    "category": "Catégorie",
    "text": "Texte",
    "id": "Identifiant",
    "constant": "Constante",
}


def column_kind(s: pd.Series) -> str:
    n = len(s)
    nunique = s.nunique(dropna=True)
    if nunique <= 1:
        return "constant"
    if pd.api.types.is_bool_dtype(s):
        return "boolean"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    if pd.api.types.is_numeric_dtype(s):
        if nunique == 2:
            return "boolean"
        if pd.api.types.is_integer_dtype(s) and nunique == n and n > 20:
            return "id"
        return "numeric"
    if n and nunique / n > 0.95 and n > 20:
        lengths = s.dropna().astype(str).str.len()
        return "text" if lengths.mean() > 30 else "id"
    if nunique <= max(30, int(0.05 * n)):
        return "category"
    return "text"


def profile_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Une ligne par colonne : type, complétude, cardinalité, exemples / statistiques."""
    rows = []
    n = len(df)
    for col in df.columns:
        s = df[col]
        kind = column_kind(s)
        missing = int(s.isna().sum())
        row = {
            "Colonne": col,
            "Type": KIND_LABELS[kind],
            "Complétude": 1 - missing / n if n else 0.0,
            "Manquantes": missing,
            "Distinctes": int(s.nunique(dropna=True)),
            "Min": np.nan,
            "Médiane": np.nan,
            "Max": np.nan,
            "Valeur fréquente": "",
        }
        if kind == "numeric" and s.notna().any():
            row.update(Min=float(s.min()), Médiane=float(s.median()), Max=float(s.max()))
        elif kind == "datetime" and s.notna().any():
            row["Valeur fréquente"] = f"{s.min():%d/%m/%Y} → {s.max():%d/%m/%Y}"
        if not row["Valeur fréquente"] and s.notna().any() and kind != "numeric":
            top = s.value_counts(dropna=True)
            if not top.empty:
                row["Valeur fréquente"] = f"{top.index[0]} ({top.iloc[0]})"
        rows.append(row)
    return pd.DataFrame(rows)


@dataclass
class QualityReport:
    score: int
    completeness: float
    duplicate_rows: int
    constant_columns: list[str] = field(default_factory=list)
    high_missing: list[tuple[str, float]] = field(default_factory=list)
    outlier_columns: list[tuple[str, float]] = field(default_factory=list)
    numeric_as_text: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)

    @property
    def grade(self) -> str:
        if self.score >= 90:
            return "Excellente"
        if self.score >= 75:
            return "Bonne"
        if self.score >= 55:
            return "Moyenne"
        return "Faible"


def _outlier_share(s: pd.Series) -> float:
    s = s.dropna()
    if len(s) < 10:
        return 0.0
    q1, q3 = np.percentile(s, [25, 75])
    iqr = q3 - q1
    if iqr == 0:
        return 0.0
    mask = (s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)
    return float(mask.mean())


def quality_report(df: pd.DataFrame) -> QualityReport:
    n_cells = df.size or 1
    completeness = 1 - float(df.isna().sum().sum()) / n_cells
    try:
        duplicates = int(df.duplicated().sum())
    except TypeError:  # colonnes non hachables (listes, dicts)
        duplicates = 0

    constant = [c for c in df.columns if df[c].nunique(dropna=True) <= 1]
    high_missing = [(c, float(df[c].isna().mean())) for c in df.columns if df[c].isna().mean() > 0.2]
    outliers = []
    for c in df.select_dtypes(include="number").columns:
        share = _outlier_share(df[c])
        if share > 0.05:
            outliers.append((c, share))
    numeric_as_text = []
    for c in df.select_dtypes(include=["object", "string"]).columns:
        sample = df[c].dropna().astype(str).head(300).str.replace(",", ".", regex=False).str.strip()
        if len(sample) and pd.to_numeric(sample, errors="coerce").notna().mean() > 0.9:
            numeric_as_text.append(c)

    # Score : complétude (50), unicité des lignes (20), colonnes utiles (15), cohérence (15).
    score = 50 * completeness
    score += 20 * (1 - min(1.0, duplicates / max(1, len(df)) * 5))
    score += 15 * (1 - len(constant) / max(1, df.shape[1]))
    penalty = (len(numeric_as_text) + 0.5 * len(outliers)) / max(1, df.shape[1])
    score += 15 * (1 - min(1.0, penalty))

    recos = []
    if duplicates:
        recos.append(f"Supprimer ou expliquer les {duplicates} ligne(s) en double.")
    for c, share in sorted(high_missing, key=lambda x: -x[1])[:5]:
        recos.append(f"`{c}` : {share:.0%} de valeurs manquantes — imputer, compléter ou écarter.")
    for c in numeric_as_text[:5]:
        recos.append(f"`{c}` contient des nombres stockés en texte — convertir en numérique.")
    for c, share in sorted(outliers, key=lambda x: -x[1])[:5]:
        recos.append(f"`{c}` : {share:.0%} de valeurs atypiques (IQR) — vérifier saisie ou unité.")
    if constant:
        recos.append("Colonnes constantes sans information : " + ", ".join(f"`{c}`" for c in constant[:6]) + ".")
    if not recos:
        recos.append("Aucun problème majeur détecté : les données sont prêtes pour l'analyse.")

    return QualityReport(
        score=int(round(score)),
        completeness=completeness,
        duplicate_rows=duplicates,
        constant_columns=constant,
        high_missing=high_missing,
        outlier_columns=outliers,
        numeric_as_text=numeric_as_text,
        recommendations=recos,
    )


def memory_usage(df: pd.DataFrame) -> str:
    size = float(df.memory_usage(deep=True).sum())
    for unit in ("o", "Ko", "Mo", "Go"):
        if size < 1024:
            return f"{size:.0f} {unit}" if unit == "o" else f"{size:.1f} {unit}".replace(".", ",")
        size /= 1024
    return f"{size:.1f} To"
