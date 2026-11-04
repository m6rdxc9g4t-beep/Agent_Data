"""Outil ``run_python`` : exécution réelle du code écrit par l'IA.

Le code tourne dans un espace de noms persistant (comme une cellule de notebook)
où ``df`` contient le jeu de données ; la sortie texte est capturée et chaque
figure matplotlib est renvoyée en PNG.

Garde-fous :
- délai maximal par exécution (``timeout``), vérifié à chaque appel de fonction Python ;
- sortie tronquée au-delà de ``MAX_OUTPUT_CHARS`` pour ne pas saturer le contexte ;
- ``df_original`` garde une copie intacte des données importées.

Sécurité : comme un notebook, cet outil exécute du code arbitraire dans le processus.
Sur un serveur, faites tourner DataMind dans un conteneur, derrière une authentification.
"""

from __future__ import annotations

import contextlib
import io
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

try:
    import seaborn as sns  # noqa: E402
except Exception:  # noqa: BLE001
    sns = None

MAX_OUTPUT_CHARS = 12_000

RUN_PYTHON_TOOL: dict[str, Any] = {
    "name": "run_python",
    "description": (
        "Exécute du code Python sur le jeu de données et renvoie la sortie texte "
        "ainsi que les graphiques produits.\n\n"
        "Déjà disponibles : `df` (DataFrame pandas des données importées), "
        "`df_original` (copie intacte), `pd`, `np`, `plt` (matplotlib.pyplot), "
        "`sns` (seaborn). scikit-learn est installé (`from sklearn... import ...`).\n\n"
        "Règles :\n"
        "- Affiche toujours les résultats avec `print(...)` : une expression seule ne renvoie rien.\n"
        "- Pour un graphique, crée une figure matplotlib/seaborn titrée ; n'appelle pas "
        "`plt.show()`, la figure est capturée automatiquement.\n"
        "- Les variables persistent d'un appel à l'autre pendant la conversation.\n"
        "- En cas d'erreur, le traceback t'est renvoyé : corrige et réessaie."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"code": {"type": "string", "description": "Le code Python à exécuter."}},
        "required": ["code"],
    },
}


@dataclass
class ExecutionResult:
    code: str
    output: str
    figures: list[bytes] = field(default_factory=list)
    is_error: bool = False
    duration: float = 0.0

    def as_event(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "output": self.output,
            "figures": self.figures,
            "is_error": self.is_error,
            "duration": round(self.duration, 2),
        }


class ExecutionTimeout(Exception):
    """Le code a dépassé le délai autorisé."""


# --------------------------------------------------------------------------- #
# Style des graphiques produits par l'IA (sobre, lisible, cohérent avec l'interface)
# --------------------------------------------------------------------------- #
CHART_PALETTE = ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444",
                 "#8B5CF6", "#EC4899", "#14B8A6", "#64748B"]


def apply_chart_style() -> None:
    plt.rcParams.update({
        "figure.figsize": (8, 4.5),
        "figure.dpi": 110,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.edgecolor": "#CBD5E1",
        "axes.labelcolor": "#334155",
        "axes.titlesize": 12,
        "axes.titleweight": "semibold",
        "axes.titlelocation": "left",
        "axes.titlepad": 12,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.axisbelow": True,
        "axes.prop_cycle": matplotlib.cycler(color=CHART_PALETTE),
        "grid.color": "#E2E8F0",
        "grid.linewidth": 0.7,
        "xtick.color": "#64748B",
        "ytick.color": "#64748B",
        "font.size": 9.5,
        "legend.frameon": False,
    })


apply_chart_style()


# --------------------------------------------------------------------------- #
# Espace de noms
# --------------------------------------------------------------------------- #
def build_namespace(df: pd.DataFrame | None) -> dict[str, Any]:
    """Espace de noms initial : données + bibliothèques."""
    namespace: dict[str, Any] = {"pd": pd, "np": np, "plt": plt}
    if sns is not None:
        namespace["sns"] = sns
    if df is not None:
        namespace["df"] = df.copy()
        namespace["df_original"] = df
    return namespace


def _ensure_libraries(namespace: dict[str, Any], df: pd.DataFrame | None) -> None:
    namespace.setdefault("pd", pd)
    namespace.setdefault("np", np)
    namespace.setdefault("plt", plt)
    if sns is not None:
        namespace.setdefault("sns", sns)
    # Si l'IA a écrasé df par autre chose qu'un DataFrame, on le restaure.
    if df is not None and not isinstance(namespace.get("df"), pd.DataFrame):
        namespace["df"] = df.copy()
    if df is not None:
        namespace.setdefault("df_original", df)


@contextlib.contextmanager
def _deadline(seconds: float):
    """Interrompt le code Python au-delà de ``seconds`` (fonctionne hors du thread principal)."""
    if not seconds or seconds <= 0:
        yield
        return
    limit = time.monotonic() + seconds
    previous = sys.gettrace()

    def tracer(frame, event, arg):  # noqa: ARG001
        if event == "call" and time.monotonic() > limit:
            raise ExecutionTimeout(f"Exécution interrompue : plus de {int(seconds)} s.")
        return None  # pas de traçage ligne à ligne : coût négligeable

    sys.settrace(tracer)
    try:
        yield
    finally:
        sys.settrace(previous)


def execute_python(
    code: str,
    namespace: dict[str, Any],
    df: pd.DataFrame | None = None,
    timeout: float = 120,
) -> ExecutionResult:
    """Exécute ``code`` dans ``namespace`` et renvoie un ``ExecutionResult``."""
    _ensure_libraries(namespace, df)
    plt.close("all")
    apply_chart_style()

    buffer = io.StringIO()
    is_error = False
    start = time.monotonic()
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer), _deadline(timeout):
            exec(compile(code, "<analyse>", "exec"), namespace)  # noqa: S102 — exécution voulue
    except ExecutionTimeout as exc:
        is_error = True
        buffer.write(f"\n{exc} Simplifie le calcul ou travaille sur un échantillon.")
    except Exception:  # noqa: BLE001
        is_error = True
        buffer.write("\n" + traceback.format_exc(limit=4))
    duration = time.monotonic() - start

    figures: list[bytes] = []
    for num in plt.get_fignums():
        fig = plt.figure(num)
        if not fig.get_axes():
            continue
        img = io.BytesIO()
        fig.savefig(img, format="png", dpi=130, bbox_inches="tight", facecolor="white")
        figures.append(img.getvalue())
    plt.close("all")

    output = buffer.getvalue()
    if len(output) > MAX_OUTPUT_CHARS:
        output = output[:MAX_OUTPUT_CHARS] + "\n… [sortie tronquée]"
    if not output.strip() and not is_error:
        output = "(code exécuté sans sortie texte)"
        if figures:
            output += f" — {len(figures)} figure(s) générée(s)."

    return ExecutionResult(code=code, output=output, figures=figures,
                           is_error=is_error, duration=duration)
