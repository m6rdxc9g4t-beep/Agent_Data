"""Graphiques automatiques de l'onglet Exploration (sans IA).

Les types de colonnes sont détectés, puis quelques graphiques pertinents sont
générés : évolution temporelle, comparaison par catégorie, répartition,
distribution. Les couleurs suivent le thème actif (clair / sombre).
"""

from __future__ import annotations

import re

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker as mticker  # noqa: E402
import pandas as pd  # noqa: E402

from .profiling import column_kind  # noqa: E402

# Indicateurs « à sommer », du plus parlant au moins parlant.
_MEASURES = [
    re.compile(r"(montant|d[ée]pense|vente|revenu|chiffre|^ca$|_ca$|total|amount|sales|revenue|"
               r"profit|marge|margin|budget)", re.I),
    re.compile(r"(prix|price|co[uû]t|cost|quantit|qty|volume|valeur|value|nb_|nombre|count)", re.I),
]
_AVERAGE = re.compile(r"(^age$|_age$|ann[ée]e|year|mois|month|anciennet|note|satisf|taux|rate|ratio|score|"
                      r"pourcent|percent|^id|_id$|code|lat|lon|churn|temp)", re.I)


def pick_measure(df: pd.DataFrame, numeric: list[str]) -> tuple[str | None, str]:
    """Indicateur principal et agrégation adaptée : (colonne, « sum » ou « mean »)."""
    if not numeric:
        return None, "sum"
    for pattern in _MEASURES:
        for col in numeric:
            if pattern.search(col) and not _AVERAGE.search(col):
                return col, "sum"
    for col in numeric:
        if not _AVERAGE.search(col) and (df[col].dropna() >= 0).all():
            return col, "sum"
    return numeric[0], "mean"


def classify_columns(df: pd.DataFrame) -> tuple[list[str], list[str], str | None]:
    """(colonnes numériques utiles, colonnes catégorielles, colonne de date)."""
    kinds = {c: column_kind(df[c]) for c in df.columns}
    numeric = [c for c, k in kinds.items() if k == "numeric"]
    categorical = [c for c, k in kinds.items() if k in ("category", "boolean") and df[c].nunique() <= 20]
    date_col = next((c for c, k in kinds.items() if k == "datetime"), None)
    return numeric, categorical, date_col


def fmt_compact(value: float) -> str:
    """1 234 567 → « 1,2 M » (format français)."""
    a = abs(value)
    if a >= 1e9:
        out = f"{value / 1e9:.1f} Md"
    elif a >= 1e6:
        out = f"{value / 1e6:.1f} M"
    elif a >= 1e4:
        out = f"{value / 1e3:.1f} k"
    elif a >= 100 or float(value).is_integer():
        out = f"{value:,.0f}".replace(",", " ")
    else:
        out = f"{value:.2f}"
    return out.replace(".", ",")


def _new_axes(theme: dict, size=(6.4, 3.4)):
    fig, ax = plt.subplots(figsize=size, dpi=120)
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")
    ax.tick_params(colors=theme["muted"], labelsize=9, length=0)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(theme["border"])
    ax.grid(True, axis="y", color=theme["border"], linewidth=0.6)
    ax.grid(False, axis="x")
    ax.set_axisbelow(True)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: fmt_compact(v)))
    return fig, ax


def _title(ax, theme: dict, title: str, subtitle: str = "") -> None:
    ax.set_title(title, color=theme["text"], fontsize=12, fontweight="semibold",
                 loc="left", pad=20 if subtitle else 10)
    if subtitle:
        ax.text(0, 1.03, subtitle, transform=ax.transAxes, color=theme["muted"], fontsize=9)


def auto_figures(df: pd.DataFrame, theme: dict) -> list[tuple[str, plt.Figure]]:
    numeric, categorical, date_col = classify_columns(df)
    colors = theme["chart"]
    figures: list[tuple[str, plt.Figure]] = []
    main, agg = pick_measure(df, numeric)
    agg_label = "Somme" if agg == "sum" else "Moyenne"

    # 1) Évolution mensuelle de l'indicateur principal.
    if date_col and main:
        tmp = df[[date_col, main]].dropna()
        serie = tmp.groupby(tmp[date_col].dt.to_period("M"))[main].agg(agg)
        if len(serie) > 1:
            fig, ax = _new_axes(theme)
            x = range(len(serie))
            ax.plot(x, serie.values, color=colors[0], linewidth=2)
            ax.fill_between(x, serie.values, color=colors[0], alpha=0.08)
            step = max(1, len(serie) // 8)
            ax.set_xticks(list(x)[::step])
            ax.set_xticklabels([p.strftime("%m/%y") for p in serie.index][::step])
            _title(ax, theme, f"Évolution de {main}", f"{agg_label} mensuelle")
            fig.tight_layout()
            figures.append((f"Évolution de {main}", fig))

    # 2) Indicateur principal par catégorie (barres horizontales, top 10).
    if categorical and main:
        cat = categorical[0]
        grp = df.groupby(cat, observed=True)[main].agg(agg).sort_values().tail(10)
        if len(grp) > 1:
            fig, ax = _new_axes(theme)
            ax.grid(True, axis="x", color=theme["border"], linewidth=0.6)
            ax.grid(False, axis="y")
            ax.barh([str(i) for i in grp.index], grp.values, color=colors[0], height=0.62)
            ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: fmt_compact(v)))
            ax.set_yticks(range(len(grp)))
            ax.set_yticklabels([str(i) for i in grp.index])
            _title(ax, theme, f"{main} par {cat}", f"{agg_label}, 10 premières modalités")
            fig.tight_layout()
            figures.append((f"{main} par {cat}", fig))

    # 3) Répartition d'une catégorie (anneau).
    if categorical:
        cat = categorical[1] if len(categorical) > 1 else categorical[0]
        counts = df[cat].value_counts().head(6)
        if len(counts) > 1:
            fig, ax = plt.subplots(figsize=(6.4, 3.4), dpi=120)
            fig.patch.set_alpha(0)
            wedges, _ = ax.pie(
                counts.values, colors=colors[: len(counts)], startangle=90, counterclock=False,
                wedgeprops={"width": 0.38, "edgecolor": theme["surface"], "linewidth": 2},
            )
            total = counts.sum()
            ax.legend(wedges, [f"{k}  {v / total:.0%}" for k, v in counts.items()],
                      loc="center left", bbox_to_anchor=(1, 0.5), frameon=False,
                      labelcolor=theme["text"], fontsize=9)
            _title(ax, theme, f"Répartition : {cat}", f"{total} lignes")
            fig.tight_layout()
            figures.append((f"Répartition : {cat}", fig))

    # 4) Distribution d'une variable numérique.
    if numeric:
        others = [c for c in numeric if c != main]
        num = others[0] if others else numeric[0]
        values = df[num].dropna()
        if len(values) > 5:
            fig, ax = _new_axes(theme)
            ax.hist(values, bins=min(30, max(8, len(values) // 15)), color=colors[1],
                    edgecolor=theme["surface"], linewidth=0.8)
            ax.axvline(values.median(), color=theme["text"], linewidth=1, linestyle="--")
            ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: fmt_compact(v)))
            _title(ax, theme, f"Distribution de {num}", f"Médiane : {fmt_compact(values.median())}")
            fig.tight_layout()
            figures.append((f"Distribution de {num}", fig))

    return figures


def column_figure(df: pd.DataFrame, col: str, theme: dict) -> plt.Figure | None:
    """Graphique adapté à une colonne choisie par l'utilisateur."""
    s = df[col].dropna()
    if s.empty:
        return None
    kind = column_kind(df[col])
    colors = theme["chart"]
    fig, ax = _new_axes(theme, size=(7.2, 3.2))
    if kind == "numeric":
        ax.hist(s, bins=min(40, max(8, len(s) // 15)), color=colors[0],
                edgecolor=theme["surface"], linewidth=0.8)
        ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: fmt_compact(v)))
        _title(ax, theme, f"Distribution de {col}")
    elif kind == "datetime":
        counts = s.dt.to_period("M").value_counts().sort_index()
        ax.bar(range(len(counts)), counts.values, color=colors[0])
        step = max(1, len(counts) // 8)
        ax.set_xticks(list(range(len(counts)))[::step])
        ax.set_xticklabels([p.strftime("%m/%y") for p in counts.index][::step])
        _title(ax, theme, f"Lignes par mois : {col}")
    else:
        counts = s.astype(str).value_counts().head(12).sort_values()
        ax.grid(True, axis="x", color=theme["border"], linewidth=0.6)
        ax.grid(False, axis="y")
        ax.barh(range(len(counts)), counts.values, color=colors[0], height=0.62)
        ax.set_yticks(range(len(counts)))
        ax.set_yticklabels([v[:28] for v in counts.index])
        ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: fmt_compact(v)))
        _title(ax, theme, f"Modalités les plus fréquentes : {col}")
    fig.tight_layout()
    return fig
