"""Moteurs IA de DataMind : Claude (API Anthropic) et Ollama (local)."""

from .base import Engine, EngineError, EventCallback
from .claude import ClaudeEngine
from .ollama import OllamaEngine, list_models

ENGINE_LABELS = {
    "ollama": "Ollama — modèle local",
    "claude": "Claude — API Anthropic",
}

__all__ = ["Engine", "EngineError", "EventCallback", "ClaudeEngine", "OllamaEngine",
           "list_models", "ENGINE_LABELS"]
