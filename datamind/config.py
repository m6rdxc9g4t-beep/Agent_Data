"""Réglages de DataMind, lus une fois dans l'environnement.

Toutes les variables sont facultatives ; les valeurs par défaut conviennent à un
usage local (Ollama sur la machine, http://localhost:11434).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def load_dotenv(path: Path = Path(__file__).resolve().parents[1] / ".env") -> None:
    """Lit un fichier .env simple (CLE=valeur) sans écraser l'environnement existant."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


load_dotenv()


def _env(*names: str, default: str = "") -> str:
    """Première variable d'environnement non vide parmi ``names``."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# Modèles Claude proposés dans l'interface (le premier est le défaut).
CLAUDE_MODELS: list[tuple[str, str]] = [
    ("claude-sonnet-5-5", "Claude Sonnet 5.5 — équilibré"),
    ("claude-opus-5-5", "Claude Opus 5.5 — le plus précis"),
    ("claude-haiku-5-5", "Claude Haiku 5.5 — le plus rapide"),
]


@dataclass(frozen=True)
class Settings:
    # Moteur par défaut : « ollama » (local, gratuit) ou « claude » (API Anthropic).
    default_engine: str = field(default_factory=lambda: _env("DATAMIND_ENGINE", default="ollama"))

    # Ollama : OLLAMA_HOST (convention Ollama), OLLAMA_URL / OLLAMA_BASE_URL (suite Atelier).
    ollama_host: str = field(default_factory=lambda: _env(
        "OLLAMA_HOST", "OLLAMA_URL", "OLLAMA_BASE_URL", default="http://localhost:11434"))
    ollama_model: str = field(default_factory=lambda: _env("OLLAMA_MODEL", default="llama3.1"))
    # Délai d'une réponse : sans carte graphique, un modèle local peut mettre plusieurs minutes.
    ollama_timeout: int = field(default_factory=lambda: _env_int("OLLAMA_TIMEOUT", 600))
    ollama_num_ctx: int = field(default_factory=lambda: _env_int("OLLAMA_NUM_CTX", 8192))

    # Claude
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    claude_model: str = field(default_factory=lambda: _env(
        "DATAMIND_CLAUDE_MODEL", "DATA_ANALYST_MODEL", default=CLAUDE_MODELS[0][0]))

    # Garde-fous de la boucle agentique et de l'exécution du code.
    max_steps: int = field(default_factory=lambda: _env_int("DATAMIND_MAX_STEPS", 12))
    exec_timeout: int = field(default_factory=lambda: _env_int("DATAMIND_EXEC_TIMEOUT", 120))

    # Libellé facultatif affiché sous le nom (ex. « Suite Atelier »).
    instance_label: str = field(default_factory=lambda: _env("DATAMIND_INSTANCE_LABEL"))


def get_settings() -> Settings:
    return Settings()
