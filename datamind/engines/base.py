"""Interface commune des moteurs IA.

Un moteur exécute la boucle agentique : il appelle le modèle, exécute les appels
à ``run_python`` et renvoie les résultats au modèle jusqu'à la réponse finale.
L'interface reçoit le déroulé au fil de l'eau via ``on_event(kind, payload)`` :

- ``"text"`` : payload = texte Markdown de l'assistant ;
- ``"tool"`` : payload = dict {code, output, figures, is_error, duration}.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable

import pandas as pd

from ..executor import execute_python

EventCallback = Callable[[str, Any], None]

STEP_LIMIT_MESSAGE = (
    "Analyse interrompue : nombre maximal d'étapes atteint. "
    "Précisez la demande ou relancez pour continuer."
)


class EngineError(Exception):
    """Erreur lisible par l'utilisateur (connexion, clé, modèle…)."""


class Engine(ABC):
    key: str = ""
    label: str = ""

    def __init__(self, *, max_steps: int = 12, exec_timeout: float = 120) -> None:
        self.max_steps = max_steps
        self.exec_timeout = exec_timeout

    @property
    def model_label(self) -> str:
        return self.label

    @abstractmethod
    def run(
        self,
        system: str,
        messages: list[Any],
        namespace: dict[str, Any],
        df: pd.DataFrame | None,
        on_event: EventCallback,
    ) -> dict[str, int]:
        """Exécute la boucle en mutant ``messages`` ; renvoie l'usage en tokens."""

    def _run_code(self, code: str, namespace, df, on_event) -> tuple[str, bool]:
        result = execute_python(code, namespace, df, timeout=self.exec_timeout)
        on_event("tool", result.as_event())
        return result.output, result.is_error
