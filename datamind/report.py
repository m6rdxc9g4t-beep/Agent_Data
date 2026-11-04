"""Export de la conversation : rapport HTML autonome (graphiques intégrés) ou Markdown."""

from __future__ import annotations

import base64
import html
from datetime import datetime

try:
    import markdown as _md
except Exception:  # noqa: BLE001
    _md = None

from . import APP_NAME, __version__


def _md_to_html(text: str) -> str:
    if _md is None:
        return f"<p>{html.escape(text).replace(chr(10), '<br>')}</p>"
    return _md.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])


_CSS = """
body{font:15px/1.6 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828;background:#F7F8FA;margin:0}
main{max-width:880px;margin:0 auto;padding:48px 28px}
header{border-bottom:1px solid #E4E7EC;padding-bottom:20px;margin-bottom:28px}
h1{font-size:26px;margin:0 0 6px}
.meta{color:#667085;font-size:13px}
.q{background:#EEF2FF;border:1px solid #C7D2FE;border-radius:10px;padding:12px 16px;margin:28px 0 12px;font-weight:600;color:#3730A3}
.a{background:#fff;border:1px solid #E4E7EC;border-radius:10px;padding:4px 20px;margin:8px 0}
.a table{border-collapse:collapse;margin:10px 0}.a td,.a th{border:1px solid #E4E7EC;padding:4px 10px}
details{margin:8px 0;border:1px solid #E4E7EC;border-radius:8px;background:#fff}
summary{cursor:pointer;padding:8px 14px;color:#475467;font-size:13px}
pre{background:#0F172A;color:#E2E8F0;padding:14px;border-radius:0 0 8px 8px;margin:0;overflow:auto;font:12px/1.5 'JetBrains Mono',monospace}
pre.out{background:#F1F3F7;color:#344054}
img{max-width:100%;border:1px solid #E4E7EC;border-radius:8px;margin:8px 0;background:#fff}
footer{margin-top:40px;color:#98A2B3;font-size:12px;text-align:center}
"""


def build_html_report(transcript: list[dict], dataset_name: str | None, shape: tuple[int, int] | None,
                      engine_label: str) -> str:
    now = datetime.now().strftime("%d/%m/%Y à %H:%M")
    parts = []
    for item in transcript:
        role = item.get("role")
        if role == "user":
            parts.append(f'<div class="q">{html.escape(item["text"])}</div>')
        elif role == "assistant":
            parts.append(f'<div class="a">{_md_to_html(item["text"])}</div>')
        elif role == "tool":
            label = "Code exécuté" + (" — erreur" if item.get("is_error") else "")
            parts.append(
                f"<details><summary>{label}</summary><pre>{html.escape(item.get('code', ''))}</pre>"
                f"<pre class='out'>{html.escape(item.get('output', ''))}</pre></details>"
            )
            for fig in item.get("figures", []):
                b64 = base64.b64encode(fig).decode()
                parts.append(f'<img alt="Graphique" src="data:image/png;base64,{b64}">')
    data = html.escape(dataset_name or "—")
    dims = f" · {shape[0]:,} lignes × {shape[1]} colonnes".replace(",", " ") if shape else ""
    return (
        "<!doctype html><html lang='fr'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Rapport {APP_NAME} — {data}</title><style>{_CSS}</style></head><body><main>"
        f"<header><h1>Rapport d'analyse</h1><div class='meta'>Jeu de données : <b>{data}</b>{dims}"
        f"<br>Généré le {now} · moteur : {html.escape(engine_label)}</div></header>"
        + "".join(parts)
        + f"<footer>{APP_NAME} {__version__} — les chiffres proviennent de code exécuté sur les données.</footer>"
        "</main></body></html>"
    )


def build_markdown_report(transcript: list[dict], dataset_name: str | None) -> str:
    lines = [f"# Rapport d'analyse — {dataset_name or 'jeu de données'}",
             f"_Généré par {APP_NAME} le {datetime.now():%d/%m/%Y à %H:%M}_", ""]
    for item in transcript:
        role = item.get("role")
        if role == "user":
            lines += [f"## {item['text']}", ""]
        elif role == "assistant":
            lines += [item["text"], ""]
        elif role == "tool":
            lines += ["```python", item.get("code", "").rstrip(), "```", ""]
            if item.get("figures"):
                lines += [f"_{len(item['figures'])} graphique(s) — voir l'export HTML._", ""]
    return "\n".join(lines)
