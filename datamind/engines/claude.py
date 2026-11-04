"""Moteur Claude (API Anthropic).

- Mise en cache du prompt système et de l'outil (``cache_control``) : les tours
  suivants d'une conversation coûtent nettement moins cher.
- Réflexion adaptative si le modèle l'accepte ; sinon, repli automatique sans réflexion.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from ..executor import RUN_PYTHON_TOOL
from .base import STEP_LIMIT_MESSAGE, Engine, EngineError, EventCallback


class ClaudeEngine(Engine):
    key = "claude"

    def __init__(self, api_key: str, model: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        if not api_key:
            raise EngineError("Clé API Anthropic manquante.")
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover
            raise EngineError("Paquet « anthropic » manquant : `pip install anthropic`.") from exc
        self._anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, max_retries=3)
        self.model = model
        self.thinking = True

    @property
    def model_label(self) -> str:
        return self.model

    def _create(self, system: str, messages: list[Any]):
        tool = {**RUN_PYTHON_TOOL, "cache_control": {"type": "ephemeral"}}
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 16000,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "tools": [tool],
            "messages": messages,
        }
        if self.thinking:
            kwargs["thinking"] = {"type": "adaptive"}
        try:
            return self.client.messages.create(**kwargs)
        except self._anthropic.BadRequestError as exc:
            if self.thinking and "thinking" in str(exc).lower():
                self.thinking = False
                kwargs.pop("thinking", None)
                return self.client.messages.create(**kwargs)
            raise

    def run(self, system: str, messages: list[Any], namespace: dict[str, Any],
            df: pd.DataFrame | None, on_event: EventCallback) -> dict[str, int]:
        a = self._anthropic
        usage = {"input_tokens": 0, "output_tokens": 0}
        try:
            for _ in range(self.max_steps):
                response = self._create(system, messages)
                u = response.usage
                usage["input_tokens"] += (getattr(u, "input_tokens", 0) or 0) + (
                    getattr(u, "cache_read_input_tokens", 0) or 0) + (
                    getattr(u, "cache_creation_input_tokens", 0) or 0)
                usage["output_tokens"] += getattr(u, "output_tokens", 0) or 0

                # Contenu complet conservé (blocs de réflexion signés compris).
                messages.append({"role": "assistant", "content": response.content})

                tool_uses = []
                for block in response.content:
                    if block.type == "text" and block.text.strip():
                        on_event("text", block.text)
                    elif block.type == "tool_use":
                        tool_uses.append(block)

                if response.stop_reason != "tool_use":
                    break

                results = []
                for tu in tool_uses:
                    code = tu.input.get("code", "") if isinstance(tu.input, dict) else ""
                    output, is_error = self._run_code(code, namespace, df, on_event)
                    results.append({"type": "tool_result", "tool_use_id": tu.id,
                                    "content": output, "is_error": is_error})
                messages.append({"role": "user", "content": results})
            else:
                on_event("text", STEP_LIMIT_MESSAGE)
        except a.AuthenticationError as exc:
            raise EngineError("Clé API Anthropic refusée : vérifiez-la.") from exc
        except a.NotFoundError as exc:
            raise EngineError(f"Modèle « {self.model} » introuvable pour cette clé.") from exc
        except a.RateLimitError as exc:
            raise EngineError("Limite de débit de l'API atteinte : réessayez dans un instant.") from exc
        except a.APIConnectionError as exc:
            raise EngineError("API Anthropic injoignable : vérifiez la connexion réseau.") from exc
        return usage
