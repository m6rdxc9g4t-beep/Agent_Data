"""Couleurs des graphiques de l'interface, en mode clair et sombre.

Les widgets suivent les thèmes natifs de Streamlit (``.streamlit/config.toml``) ;
ces jetons servent aux graphiques matplotlib, rendus sur fond transparent.
"""

from __future__ import annotations

LIGHT = {
    "dark": False,
    "surface": "#F7F8FA",  # fond de la page : bords des barres et des anneaux
    "border": "#E4E7EC",
    "text": "#101828",
    "muted": "#667085",
    "chart": ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#64748B"],
}

DARK = {
    "dark": True,
    "surface": "#0B0F19",
    "border": "#243049",
    "text": "#E6E9EF",
    "muted": "#98A2B3",
    "chart": ["#818CF8", "#38BDF8", "#34D399", "#FBBF24", "#F87171", "#A78BFA", "#F472B6", "#94A3B8"],
}


def get_theme(dark: bool) -> dict:
    return DARK if dark else LIGHT
