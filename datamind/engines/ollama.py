"""Moteur Ollama (modèle local : gratuit, hors-ligne, sans clé API).

Les petits modèles locaux n'utilisent pas toujours le champ ``tool_calls`` ;
deux replis rendent l'agent fiable malgré tout :

1. appel d'outil écrit en JSON dans le texte (``{"name": "run_python", ...}``,
   travers fréquent de llama3.x) ;
2. code proposé dans un bloc ```python``` sans appel d'outil : il est exécuté et
   le résultat est renvoyé au modèle pour interprétation.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pandas as pd

from ..executor import RUN_PYTHON_TOOL
from .base import STEP_LIMIT_MESSAGE, Engine, EngineError, EventCallback

_CODE_BLOCK = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.S | re.I)


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def extract_text_tool_call(content: str) -> str | None:
    """Code d'un appel ``run_python`` écrit en JSON dans le texte, sinon ``None``."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    if not (text.startswith("{") and '"name"' in text):
        return None
    try:
        obj = json.loads(text, strict=False)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or obj.get("name") != "run_python":
        return None
    args = obj.get("parameters") or obj.get("arguments") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args, strict=False)
        except json.JSONDecodeError:
            return None
    code = args.get("code") if isinstance(args, dict) else None
    return code if isinstance(code, str) and code.strip() else None


def extract_code_blocks(content: str) -> str | None:
    """Concatène les blocs ```python``` d'une réponse (``None`` s'il n'y en a pas)."""
    blocks = [b.strip() for b in _CODE_BLOCK.findall(content or "") if b.strip()]
    return "\n\n".join(blocks) if blocks else None


def _to_ollama_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]}}


def _as_dict(message: Any) -> dict[str, Any]:
    """Message Ollama (objet pydantic ou dict) → dict simple, sérialisable."""
    if isinstance(message, dict):
        return message
    if hasattr(message, "model_dump"):
        return {k: v for k, v in message.model_dump().items() if v not in (None, [], "")} | {
            "role": _get(message, "role", "assistant"), "content": _get(message, "content", "") or ""}
    return {"role": "assistant", "content": str(message)}


def list_models(host: str, timeout: float = 10) -> list[str]:
    import ollama

    data = ollama.Client(host=host, timeout=timeout).list()
    names = []
    for item in _get(data, "models", []) or []:
        name = _get(item, "model") or _get(item, "name")
        if name:
            names.append(str(name))
    return sorted(names)


class OllamaEngine(Engine):
    key = "ollama"

    def __init__(self, host: str, model: str, timeout: float = 600, num_ctx: int = 8192,
                 run_code_blocks: bool = True, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        try:
            import ollama
        except ImportError as exc:  # pragma: no cover
            raise EngineError("Paquet « ollama » manquant : `pip install ollama`.") from exc
        self.client = ollama.Client(host=host, timeout=timeout)
        self.host, self.model, self.num_ctx = host, model, num_ctx
        self.run_code_blocks = run_code_blocks

    @property
    def model_label(self) -> str:
        return self.model

    def _chat(self, system: str, messages: list[Any]):
        try:
            return self.client.chat(
                model=self.model,
                messages=[{"role": "system", "content": system}] + messages,
                tools=[_to_ollama_tool(RUN_PYTHON_TOOL)],
                options={"num_ctx": self.num_ctx, "temperature": 0.2},
            )
        except Exception as exc:  # noqa: BLE001
            text = str(exc)
            if "not found" in text.lower() and "model" in text.lower():
                raise EngineError(
                    f"Modèle « {self.model} » absent du serveur Ollama : `ollama pull {self.model}`.") from exc
            if "does not support tools" in text:
                raise EngineError(
                    f"Le modèle « {self.model} » ne gère pas les outils. "
                    "Choisissez llama3.1, llama3.2, qwen2.5 ou mistral-nemo.") from exc
            if any(k in text for k in ("Connect", "refused", "11434", "Failed to connect", "timed out")):
                raise EngineError(
                    f"Impossible de joindre Ollama sur {self.host}. Est-il démarré ?") from exc
            raise

    def run(self, system: str, messages: list[Any], namespace: dict[str, Any],
            df: pd.DataFrame | None, on_event: EventCallback) -> dict[str, int]:
        usage = {"input_tokens": 0, "output_tokens": 0}
        last_block = None
        for _ in range(self.max_steps):
            response = self._chat(system, messages)
            usage["input_tokens"] += int(_get(response, "prompt_eval_count", 0) or 0)
            usage["output_tokens"] += int(_get(response, "eval_count", 0) or 0)

            message = _get(response, "message")
            content = _get(message, "content", "") or ""
            tool_calls = _get(message, "tool_calls", None)
            messages.append(_as_dict(message))

            # Repli 1 : appel d'outil écrit en JSON dans le texte.
            json_code = None if tool_calls else extract_text_tool_call(content)
            if json_code is not None:
                output, _ = self._run_code(json_code, namespace, df, on_event)
                messages.append({"role": "tool", "content": output, "tool_name": "run_python"})
                continue

            if content.strip():
                on_event("text", content)

            if tool_calls:
                for call in tool_calls:
                    fn = _get(call, "function", {})
                    args = _get(fn, "arguments", {})
                    if isinstance(args, str):
                        try:
                            args = json.loads(args or "{}", strict=False)
                        except json.JSONDecodeError:
                            args = {}
                    code = args.get("code", "") if isinstance(args, dict) else ""
                    output, _ = self._run_code(code, namespace, df, on_event)
                    messages.append({"role": "tool", "content": output,
                                     "tool_name": _get(fn, "name", "") or "run_python"})
                continue

            # Repli 2 : code proposé dans un bloc Markdown sans appel d'outil.
            block = extract_code_blocks(content) if self.run_code_blocks else None
            if block and block != last_block:
                last_block = block
                output, is_error = self._run_code(block, namespace, df, on_event)
                messages.append({"role": "user", "content": (
                    "Résultat de l'exécution de ton code :\n```\n" + output + "\n```\n"
                    + ("Corrige l'erreur et relance avec l'outil run_python." if is_error else
                       "Interprète ces résultats réels pour répondre à la question, sans inventer de chiffres.")
                )})
                continue
            break
        else:
            on_event("text", STEP_LIMIT_MESSAGE)
        return usage
