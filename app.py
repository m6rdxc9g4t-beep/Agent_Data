"""DataMind — interface Streamlit.

    streamlit run app.py

Onglets : Assistant (agent IA qui exécute réellement son code) · Exploration
(graphiques automatiques) · Qualité (profil et score) · Données (table filtrable).
Moteurs : Ollama (local, gratuit) ou Claude (API Anthropic).
"""

from __future__ import annotations

import base64
import html
from datetime import datetime
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import streamlit as st

from datamind import APP_NAME, __version__, charts
from datamind.config import CLAUDE_MODELS, get_settings
from datamind.engines import ENGINE_LABELS, ClaudeEngine, EngineError, OllamaEngine, list_models
from datamind.executor import build_namespace
from datamind.loader import SUPPORTED_EXTENSIONS, DataLoadError, excel_sheets, load_dataframe
from datamind.profiling import memory_usage, profile_columns, quality_report
from datamind.prompts import ALL_ANALYSES, FEATURED, QUICK_GROUPS, build_system_prompt
from datamind.report import build_html_report, build_markdown_report
from datamind.theme import get_theme

ROOT = Path(__file__).parent
ASSETS = ROOT / "assets"
SAMPLES = ROOT / "sample_data"
SETTINGS = get_settings()
UPLOAD_TYPES = [ext.lstrip(".") for ext in SUPPORTED_EXTENSIONS]
TABS = [":material/forum: Assistant", ":material/monitoring: Exploration",
        ":material/fact_check: Qualité", ":material/table_view: Données"]
SAMPLE_SETS = {
    "ventes.csv": ("Ventes", "30 commandes · produits, régions, satisfaction"),
    "demo_complet.csv": ("Clients", "400 clients · canaux, dépenses, churn"),
}

st.set_page_config(
    page_title=APP_NAME,
    page_icon=str(ASSETS / "favicon.png"),
    layout="wide",
    initial_sidebar_state="expanded",
    menu_items={"About": f"**{APP_NAME} {__version__}** — agent d'analyse de données."},
)


# --------------------------------------------------------------------------- #
# Ressources
# --------------------------------------------------------------------------- #
@st.cache_resource
def logo_uri() -> str:
    svg = (ASSETS / "logo.svg").read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(svg).decode()


@st.cache_resource
def stylesheet() -> str:
    return (ASSETS / "style.css").read_text(encoding="utf-8")


def is_dark() -> bool:
    try:
        return st.context.theme.type == "dark"
    except Exception:  # noqa: BLE001
        return False


def fmt_int(n: int | float) -> str:
    return f"{int(n):,}".replace(",", " ")


# --------------------------------------------------------------------------- #
# État de session
# --------------------------------------------------------------------------- #
def init_state() -> None:
    engine = SETTINGS.default_engine if SETTINGS.default_engine in ENGINE_LABELS else "ollama"
    defaults = {
        "df": None, "df_name": None, "df_loaded_at": None,
        "raw": None, "sheets": [], "sheet": None,
        "upload_gen": 0, "last_upload": {},
        "transcript": [], "messages": [], "namespace": {},
        "queued": None, "usage": {"input_tokens": 0, "output_tokens": 0},
        "cache": {},
        "engine": engine,
        "ollama_host": SETTINGS.ollama_host, "ollama_model": SETTINGS.ollama_model,
        "ollama_models": None, "ollama_error": None,
        "claude_model": SETTINGS.claude_model, "api_key": "",
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def reset_conversation() -> None:
    ss = st.session_state
    ss.transcript, ss.messages, ss.queued = [], [], None
    ss.usage = {"input_tokens": 0, "output_tokens": 0}
    ss.namespace = build_namespace(ss.df)


def set_dataset(df: pd.DataFrame | None, name: str | None) -> None:
    ss = st.session_state
    ss.df, ss.df_name, ss.cache = df, name, {}
    ss.df_loaded_at = datetime.now() if df is not None else None
    reset_conversation()


def cached(key: str, fn):
    """Mémorise un calcul pour le jeu de données courant (vidé à chaque changement)."""
    cache = st.session_state.cache
    if key not in cache:
        cache[key] = fn()
    return cache[key]


# --------------------------------------------------------------------------- #
# Chargement des données
# --------------------------------------------------------------------------- #
def load_bytes(name: str, raw: bytes, sheet: str | None = None) -> bool:
    ss = st.session_state
    sheets = excel_sheets(raw) if name.lower().endswith((".xlsx", ".xls")) else []
    if sheets and sheet not in sheets:
        sheet = sheets[0]
    try:
        df = load_dataframe(name, raw, sheet=sheet)
    except DataLoadError as exc:
        st.toast(str(exc), icon=":material/error:")
        return False
    ss.raw, ss.sheets, ss.sheet = raw, sheets, sheet
    set_dataset(df, name)
    return True


def handle_upload(uploaded, slot: str) -> None:
    """Charge un fichier déposé, une seule fois par fichier et par zone de dépôt."""
    if uploaded is None:
        return
    sig = (uploaded.name, uploaded.size, getattr(uploaded, "file_id", ""))
    if st.session_state.last_upload.get(slot) == sig:
        return
    st.session_state.last_upload[slot] = sig
    if load_bytes(uploaded.name, uploaded.getvalue()):
        st.rerun()


def load_sample(file_name: str) -> None:
    path = SAMPLES / file_name
    if path.exists() and load_bytes(file_name, path.read_bytes()):
        st.rerun()


def clear_dataset() -> None:
    ss = st.session_state
    ss.raw, ss.sheets, ss.sheet = None, [], None
    ss.upload_gen += 1  # nouvelle clé : les zones de dépôt se vident
    ss.last_upload = {}
    set_dataset(None, None)


# --------------------------------------------------------------------------- #
# Moteur IA
# --------------------------------------------------------------------------- #
def detect_ollama(force: bool = False) -> None:
    ss = st.session_state
    if ss.ollama_models is not None and not force:
        return
    try:
        ss.ollama_models = list_models(ss.ollama_host, timeout=4)
        ss.ollama_error = None
        if ss.ollama_models and ss.ollama_model not in ss.ollama_models:
            # « llama3.1 » désigne « llama3.1:latest » pour Ollama.
            alias = f"{ss.ollama_model}:latest"
            ss.ollama_model = alias if alias in ss.ollama_models else ss.ollama_models[0]
    except Exception as exc:  # noqa: BLE001
        ss.ollama_models = []
        ss.ollama_error = str(exc) or exc.__class__.__name__


def claude_key() -> str:
    return SETTINGS.anthropic_api_key or st.session_state.api_key.strip()


def engine_status() -> tuple[bool, str, str]:
    """(prêt, libellé court, classe CSS de la pastille)."""
    ss = st.session_state
    if ss.engine == "claude":
        if claude_key():
            return True, f"Claude · {ss.claude_model}", "ok"
        return False, "Clé API requise", "warn"
    if ss.ollama_error:
        return False, "Ollama injoignable", "err"
    if not ss.ollama_models:
        return False, "Aucun modèle Ollama", "warn"
    return True, f"Ollama · {ss.ollama_model}", "ok"


def build_engine():
    ss = st.session_state
    common = {"max_steps": SETTINGS.max_steps, "exec_timeout": SETTINGS.exec_timeout}
    if ss.engine == "claude":
        return ClaudeEngine(api_key=claude_key(), model=ss.claude_model, **common)
    return OllamaEngine(host=ss.ollama_host, model=ss.ollama_model, timeout=SETTINGS.ollama_timeout,
                        num_ctx=SETTINGS.ollama_num_ctx, **common)


# --------------------------------------------------------------------------- #
# Barre latérale
# --------------------------------------------------------------------------- #
def sidebar_brand() -> None:
    sub = SETTINGS.instance_label or "Agent d'analyse de données"
    st.markdown(
        f'<div class="dm-brand"><img src="{logo_uri()}" alt="">'
        f'<div><div class="dm-brand-name">{APP_NAME}</div>'
        f'<div class="dm-brand-sub">{html.escape(sub)}</div></div></div>',
        unsafe_allow_html=True,
    )


def sidebar_data() -> None:
    ss = st.session_state
    st.markdown('<div class="dm-label">Jeu de données</div>', unsafe_allow_html=True)
    if ss.df is not None:
        ext = Path(ss.df_name or "").suffix.lstrip(".").upper()[:4] or "DATA"
        st.markdown(
            f'<div class="dm-file"><div class="dm-file-icon">{html.escape(ext)}</div><div style="min-width:0">'
            f'<div class="dm-file-name" title="{html.escape(ss.df_name)}">{html.escape(ss.df_name)}</div>'
            f'<div class="dm-file-meta">{fmt_int(ss.df.shape[0])} lignes · {ss.df.shape[1]} colonnes · '
            f"{memory_usage(ss.df)}</div></div></div>",
            unsafe_allow_html=True,
        )
        if len(ss.sheets) > 1:
            sheet = st.selectbox("Feuille", ss.sheets, index=ss.sheets.index(ss.sheet))
            if sheet != ss.sheet and load_bytes(ss.df_name, ss.raw, sheet):
                st.rerun()
    uploaded = st.file_uploader(
        "Importer un fichier", type=UPLOAD_TYPES, key=f"side_up_{ss.upload_gen}",
        label_visibility="collapsed",
        help="CSV, TSV, Excel, JSON, JSON Lines ou Parquet — 200 Mo maximum.",
    )
    handle_upload(uploaded, "side")
    if ss.df is not None:
        if st.button("Retirer le jeu de données", icon=":material/close:", type="tertiary"):
            clear_dataset()
            st.rerun()
    else:
        st.caption("Ou essayez un jeu d'exemple :")
        cols = st.columns(2)
        for col, (file_name, (label, _)) in zip(cols, SAMPLE_SETS.items()):
            if col.button(label, key=f"sample_side_{file_name}", icon=":material/dataset:", width="stretch"):
                load_sample(file_name)


def sidebar_engine() -> None:
    ss = st.session_state
    st.markdown('<div class="dm-label">Moteur IA</div>', unsafe_allow_html=True)
    choice = st.segmented_control(
        "Moteur", options=list(ENGINE_LABELS), default=ss.engine, required=True,
        format_func=lambda k: "Ollama" if k == "ollama" else "Claude",
        label_visibility="collapsed", width="stretch",
    )
    if choice and choice != ss.engine:
        ss.engine = choice
        reset_conversation()
        st.rerun()

    if ss.engine == "ollama":
        detect_ollama()
    ready, label, css = engine_status()
    st.markdown(f'<span class="dm-pill {css}">{html.escape(label)}</span>', unsafe_allow_html=True)

    with st.expander("Réglages du moteur", icon=":material/tune:", expanded=not ready):
        if ss.engine == "ollama":
            host = st.text_input("Serveur Ollama", value=ss.ollama_host)
            if host != ss.ollama_host:
                ss.ollama_host = host
                detect_ollama(force=True)
                st.rerun()
            if ss.ollama_models:
                ss.ollama_model = st.selectbox(
                    "Modèle", ss.ollama_models, index=ss.ollama_models.index(ss.ollama_model)
                    if ss.ollama_model in ss.ollama_models else 0,
                    help="Le modèle doit gérer les outils : llama3.1, llama3.2, qwen2.5, mistral-nemo…")
            else:
                ss.ollama_model = st.text_input("Modèle", value=ss.ollama_model)
                if ss.ollama_error:
                    st.caption(f"Ollama ne répond pas sur {ss.ollama_host}. Lancez `ollama serve`.")
                else:
                    st.caption(f"Téléchargez un modèle : `ollama pull {ss.ollama_model}`.")
            if st.button("Tester la connexion", icon=":material/sync:", width="stretch"):
                detect_ollama(force=True)
                st.rerun()
        else:
            if SETTINGS.anthropic_api_key:
                st.caption("Clé API fournie par le serveur.")
            else:
                ss.api_key = st.text_input("Clé API Anthropic", value=ss.api_key, type="password",
                                           placeholder="sk-ant-…",
                                           help="Utilisée pour cette session uniquement, jamais enregistrée.")
            models = [m for m, _ in CLAUDE_MODELS]
            labels = dict(CLAUDE_MODELS)
            if ss.claude_model not in models:
                models.append(ss.claude_model)
            ss.claude_model = st.selectbox("Modèle", models, index=models.index(ss.claude_model),
                                           format_func=lambda m: labels.get(m, m))


def sidebar_session() -> None:
    ss = st.session_state
    st.markdown('<div class="dm-label">Conversation</div>', unsafe_allow_html=True)
    if st.button("Nouvelle conversation", icon=":material/add_comment:", width="stretch",
                 disabled=not ss.transcript):
        reset_conversation()
        st.rerun()
    if ss.transcript:
        _, label, _ = engine_status()
        shape = ss.df.shape if ss.df is not None else None
        stem = Path(ss.df_name or "analyse").stem
        st.download_button(
            "Exporter le rapport (HTML)", icon=":material/description:", width="stretch",
            data=build_html_report(ss.transcript, ss.df_name, shape, label),
            file_name=f"datamind-{stem}-{datetime.now():%Y%m%d-%H%M}.html", mime="text/html",
            on_click="ignore",
        )
        st.download_button(
            "Exporter en Markdown", icon=":material/markdown:", width="stretch", type="tertiary",
            data=build_markdown_report(ss.transcript, ss.df_name),
            file_name=f"datamind-{stem}.md", mime="text/markdown", on_click="ignore",
        )
    u = ss.usage
    tokens = (f"{fmt_int(u['input_tokens'])} tokens envoyés · {fmt_int(u['output_tokens'])} générés<br>"
              if u["input_tokens"] or u["output_tokens"] else "")
    st.markdown(
        f'<div class="dm-foot" style="margin-top:1.2rem">{tokens}'
        f"{APP_NAME} {__version__} · thème clair/sombre : menu ⋮ › Settings</div>",
        unsafe_allow_html=True,
    )


# --------------------------------------------------------------------------- #
# En-tête et accueil
# --------------------------------------------------------------------------- #
def render_header(ready: bool, engine_label: str, pill: str) -> None:
    ss = st.session_state
    df = ss.df
    report = cached("quality", lambda: quality_report(df))
    loaded = ss.df_loaded_at.strftime("%H:%M") if ss.df_loaded_at else ""
    sheet = f" · feuille « {html.escape(ss.sheet)} »" if ss.sheet and len(ss.sheets) > 1 else ""
    st.markdown(
        f'<div class="dm-head"><div><div class="dm-eyebrow">Jeu de données</div>'
        f'<div class="dm-title">{html.escape(ss.df_name)}</div>'
        f'<div class="dm-sub">Chargé à {loaded}{sheet} · {memory_usage(df)} en mémoire</div></div>'
        f'<span class="dm-pill {pill}">{html.escape(engine_label)}</span></div>',
        unsafe_allow_html=True,
    )
    score_cls = "good" if report.score >= 75 else "mid" if report.score >= 55 else "bad"
    n_dates = sum(pd.api.types.is_datetime64_any_dtype(df[c]) for c in df.columns)
    n_num = len(df.select_dtypes(include="number").columns)
    plural = lambda n, word: f"{n} {word}{'s' if n > 1 else ''}"  # noqa: E731
    kpis = [
        ("Lignes", fmt_int(df.shape[0]), "observations", ""),
        ("Colonnes", str(df.shape[1]), f"{plural(n_num, 'numérique')} · {plural(n_dates, 'date')}", ""),
        ("Complétude", f"{report.completeness:.1%}".replace(".", ","), "cellules renseignées", ""),
        ("Doublons", fmt_int(report.duplicate_rows), "lignes identiques", "mid" if report.duplicate_rows else ""),
        ("Qualité", f"{report.score}/100", report.grade, score_cls),
    ]
    st.markdown(
        '<div class="dm-kpis">' + "".join(
            f'<div class="dm-kpi"><div class="dm-kpi-label">{a}</div>'
            f'<div class="dm-kpi-value {cls}">{b}</div><div class="dm-kpi-hint">{c}</div></div>'
            for a, b, c, cls in kpis) + "</div>",
        unsafe_allow_html=True,
    )


def render_welcome(ready: bool) -> None:
    st.markdown(
        f'<div class="dm-hero"><img src="{logo_uri()}" alt=""><h1>{APP_NAME}</h1>'
        "<p>Importez un jeu de données et posez vos questions en français. L'agent écrit du code "
        "Python, l'exécute réellement sur vos données et vous restitue des chiffres vérifiables, "
        "des graphiques et des recommandations.</p></div>",
        unsafe_allow_html=True,
    )
    steps = [
        (ready, "Moteur IA", "Ollama en local, gratuit, ou Claude via l'API Anthropic."),
        (False, "Vos données", "CSV, Excel, JSON ou Parquet, jusqu'à 200 Mo."),
        (False, "Analyse", "Analyses en un clic ou questions libres ; export en rapport HTML."),
    ]
    st.markdown('<div class="dm-steps">' + "".join(
        f'<div class="dm-step{" done" if done else ""}"><div class="dm-step-n">{"✓" if done else i}</div>'
        f"<b>{t}</b><span>{h}</span></div>"
        for i, (done, t, h) in enumerate(steps, 1)) + "</div>", unsafe_allow_html=True)

    left, right = st.columns([3, 2], gap="medium")
    with left:
        uploaded = st.file_uploader(
            "Importer un fichier de données", type=UPLOAD_TYPES,
            key=f"main_up_{st.session_state.upload_gen}",
        )
        handle_upload(uploaded, "main")
    with right:
        st.markdown("**Pas de fichier sous la main ?**")
        for file_name, (label, hint) in SAMPLE_SETS.items():
            if st.button(f"**{label}** — {hint}", key=f"sample_main_{file_name}",
                         icon=":material/dataset:", width="stretch"):
                load_sample(file_name)


# --------------------------------------------------------------------------- #
# Assistant
# --------------------------------------------------------------------------- #
def render_tool_item(item: dict) -> None:
    duration = item.get("duration")
    suffix = f" · {duration:.1f} s".replace(".", ",") if duration else ""
    if item.get("is_error"):
        label, icon = f"Code exécuté — erreur{suffix}", ":material/error:"
    else:
        label, icon = f"Code exécuté{suffix}", ":material/terminal:"
    with st.expander(label, icon=icon, expanded=False):
        st.code(item.get("code", ""), language="python")
        if item.get("output", "").strip():
            st.code(item["output"], language="text")
    for fig in item.get("figures", []):
        st.image(fig, width=760)


def render_transcript() -> None:
    current = None
    for item in st.session_state.transcript:
        role = "user" if item["role"] == "user" else "assistant"
        if current is None or role == "user" or current[0] != role:
            current = (role, st.chat_message(role, avatar=":material/person:" if role == "user" else logo_path()))
        with current[1]:
            if item["role"] == "tool":
                render_tool_item(item)
            else:
                st.markdown(item["text"])


@st.cache_resource
def logo_path() -> str:
    return str(ASSETS / "favicon.png")


def queue_analysis(key: str) -> None:
    """Met une analyse rapide en file et ramène l'utilisateur sur l'onglet Assistant."""
    a = ALL_ANALYSES[key]
    st.session_state.queued = a.prompt
    st.session_state.queued_label = a.label
    st.session_state.goto_chat = True
    st.rerun()


def quick_button(key: str, ready: bool, prefix: str) -> None:
    a = ALL_ANALYSES[key]
    if st.button(f"**{a.label}**  \n{a.summary}", key=f"qa_{prefix}_{key}", icon=a.icon,
                 width="stretch", disabled=not ready):
        queue_analysis(key)


def render_suggestions(ready: bool) -> None:
    st.markdown("##### Par où commencer ?")
    if not ready:
        st.info("Configurez le moteur IA dans la barre latérale pour lancer une analyse.",
                icon=":material/info:")
    cols = st.columns(3, gap="small")
    for i, key in enumerate(FEATURED):
        with cols[i % 3]:
            quick_button(key, ready, "feat")
    with st.expander(f"Toutes les analyses ({len(ALL_ANALYSES)})", icon=":material/apps:"):
        for group, items in QUICK_GROUPS:
            st.markdown(f'<div class="dm-label">{group}</div>', unsafe_allow_html=True)
            cols = st.columns(3, gap="small")
            for i, a in enumerate(items):
                with cols[i % 3]:
                    quick_button(a.key, ready, "all")


def render_quick_popover(ready: bool) -> None:
    left, right = st.columns([5, 2], vertical_alignment="center")
    n = sum(1 for t in st.session_state.transcript if t["role"] == "user")
    left.caption(f"{n} question{'s' if n > 1 else ''} · les variables calculées restent disponibles pour la suite.")
    with right.popover("Analyses rapides", icon=":material/bolt:", width="stretch", disabled=not ready):
        for group, items in QUICK_GROUPS:
            st.markdown(f'<div class="dm-label">{group}</div>', unsafe_allow_html=True)
            for a in items:
                if st.button(a.label, key=f"qa_pop_{a.key}", icon=a.icon, width="stretch"):
                    queue_analysis(a.key)


def process_message(prompt: str, shown: str) -> None:
    ss = st.session_state
    ss.transcript.append({"role": "user", "text": shown})
    with st.chat_message("user", avatar=":material/person:"):
        st.markdown(shown)

    ss.messages.append({"role": "user", "content": prompt})

    box = st.chat_message("assistant", avatar=logo_path())
    with box:
        status = st.status("Analyse en cours…", expanded=False)
    steps = {"n": 0}

    def on_event(kind: str, payload) -> None:
        if kind == "text":
            ss.transcript.append({"role": "assistant", "text": payload})
            with box:
                st.markdown(payload)
        elif kind == "tool":
            steps["n"] += 1
            ss.transcript.append({"role": "tool", **payload})
            status.update(label=f"Analyse en cours… {steps['n']} exécution(s) de code")
            with box:
                render_tool_item(payload)

    try:
        engine = build_engine()
        system = build_system_prompt(ss.df, ss.df_name)
        usage = engine.run(system, ss.messages, ss.namespace, ss.df, on_event)
        ss.usage["input_tokens"] += usage["input_tokens"]
        ss.usage["output_tokens"] += usage["output_tokens"]
        status.update(label=f"Analyse terminée · {steps['n']} exécution(s) de code", state="complete")
    except EngineError as exc:
        status.update(label="Le moteur IA a renvoyé une erreur", state="error")
        _fail(box, str(exc))
    except Exception as exc:  # noqa: BLE001
        status.update(label="Erreur inattendue", state="error")
        _fail(box, f"Erreur inattendue : {exc}")
    # Nouveau rendu : barre latérale (export, nouvelle conversation) et compteurs à jour.
    st.rerun()


def _fail(box, message: str) -> None:
    ss = st.session_state
    ss.transcript.append({"role": "assistant", "text": f"⚠️ {message}"})
    # Retire la question sans réponse de l'historique du modèle, pour pouvoir réessayer proprement.
    if ss.messages and isinstance(ss.messages[-1], dict) and ss.messages[-1].get("role") == "user" \
            and isinstance(ss.messages[-1].get("content"), str):
        ss.messages.pop()
    with box:
        st.error(message, icon=":material/error:")


# --------------------------------------------------------------------------- #
# Exploration, Qualité, Données
# --------------------------------------------------------------------------- #
def render_exploration() -> None:
    df = st.session_state.df
    dark = is_dark()
    theme = get_theme(dark)
    figures = cached(f"figs_{dark}", lambda: [(t, _png(f)) for t, f in charts.auto_figures(df, theme)])
    if figures:
        cols = st.columns(2, gap="medium")
        for i, (_, png) in enumerate(figures):
            with cols[i % 2].container(border=True):
                st.image(png, width="stretch")
    else:
        st.caption("Pas assez de colonnes structurées pour des graphiques automatiques.")

    st.markdown("##### Explorer une colonne")
    col = st.selectbox("Colonne", list(df.columns), label_visibility="collapsed")
    left, right = st.columns([3, 2], gap="medium")
    with left.container(border=True):
        fig = charts.column_figure(df, col, theme)
        if fig is not None:
            st.image(_png(fig), width="stretch")
        else:
            st.caption("Colonne vide.")
    with right:
        s = df[col]
        if pd.api.types.is_numeric_dtype(s):
            desc = s.describe().rename({"count": "Valeurs", "mean": "Moyenne", "std": "Écart-type",
                                        "min": "Minimum", "25%": "1er quartile", "50%": "Médiane",
                                        "75%": "3e quartile", "max": "Maximum"})
            st.dataframe(desc.to_frame("Valeur"), width="stretch")
        else:
            top = s.astype(str).value_counts().head(12)
            st.dataframe(top.rename_axis("Valeur").to_frame("Occurrences"), width="stretch")
        st.caption(f"{fmt_int(s.isna().sum())} valeur(s) manquante(s) · {fmt_int(s.nunique())} distinctes")


def _png(fig) -> bytes:
    import io

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=140, bbox_inches="tight", transparent=True)
    plt.close(fig)
    return buf.getvalue()


def render_quality() -> None:
    df = st.session_state.df
    report = cached("quality", lambda: quality_report(df))
    profile = cached("profile", lambda: profile_columns(df))
    left, right = st.columns([1, 2], gap="large")
    with left:
        with st.container(border=True):
            st.markdown(f"**Score de qualité** · {report.grade}")
            st.markdown(f"<div style='font-size:2.6rem;font-weight:700;letter-spacing:-.03em'>"
                        f"{report.score}<span style='font-size:1.1rem;opacity:.5'>/100</span></div>",
                        unsafe_allow_html=True)
            st.progress(report.score / 100)
            st.caption("Complétude (50), unicité des lignes (20), colonnes informatives (15), cohérence (15).")
    with right:
        with st.container(border=True):
            st.markdown("**Recommandations**")
            st.markdown("".join(f'<div class="dm-reco">{_md_inline(r)}</div>' for r in report.recommendations),
                        unsafe_allow_html=True)
            if st.button("Demander un audit détaillé à l'agent", icon=":material/verified:",
                         disabled=not engine_status()[0]):
                queue_analysis("quality")

    st.markdown("##### Profil des colonnes")
    st.dataframe(
        profile, hide_index=True, width="stretch", height=min(600, 38 + 35 * len(profile)),
        column_config={
            "Complétude": st.column_config.ProgressColumn("Complétude", format="percent", min_value=0, max_value=1),
            "Manquantes": st.column_config.NumberColumn(format="localized"),
            "Distinctes": st.column_config.NumberColumn(format="localized"),
            "Min": st.column_config.NumberColumn(format="compact"),
            "Médiane": st.column_config.NumberColumn(format="compact"),
            "Max": st.column_config.NumberColumn(format="compact"),
        },
    )


def _md_inline(text: str) -> str:
    """`code` → <code> pour les recommandations rendues en HTML."""
    parts = html.escape(text).split("`")
    return "<span>" + "".join(f"<code>{p}</code>" if i % 2 else p for i, p in enumerate(parts)) + "</span>"


def render_data() -> None:
    df = st.session_state.df
    left, right = st.columns([3, 1], vertical_alignment="bottom")
    query = left.text_input("Rechercher", placeholder="Filtrer les lignes contenant…",
                            label_visibility="collapsed")
    view = df
    if query.strip():
        mask = df.astype(str).apply(lambda c: c.str.contains(query.strip(), case=False, regex=False)).any(axis=1)
        view = df[mask]
    right.download_button("Télécharger en CSV", icon=":material/download:", width="stretch",
                          data=view.to_csv(index=False, sep=";", decimal=",").encode("utf-8-sig"),
                          file_name=f"{Path(st.session_state.df_name).stem}.csv", mime="text/csv",
                          on_click="ignore")
    shown = view.head(5000)
    st.caption(f"{fmt_int(len(view))} ligne(s)" + (" — 5 000 premières affichées" if len(view) > 5000 else ""))
    config = {}
    for col in shown.columns:
        if pd.api.types.is_datetime64_any_dtype(shown[col]):
            s = shown[col].dropna()
            midnight = s.empty or bool((s == s.dt.normalize()).all())
            config[col] = (st.column_config.DateColumn(format="DD/MM/YYYY") if midnight
                           else st.column_config.DatetimeColumn(format="DD/MM/YYYY HH:mm"))
    st.dataframe(shown, width="stretch", height=560, hide_index=True, column_config=config)


# --------------------------------------------------------------------------- #
# Assemblage de la page
# --------------------------------------------------------------------------- #
init_state()
st.markdown(f"<style>{stylesheet()}</style>", unsafe_allow_html=True)

with st.sidebar:
    sidebar_brand()
    sidebar_data()
    sidebar_engine()
    sidebar_session()

ss = st.session_state
ready_engine, engine_label, engine_pill = engine_status()
has_data = ss.df is not None
ready = ready_engine and has_data

typed = st.chat_input(
    "Posez une question sur vos données…" if ready else
    ("Configurez le moteur IA pour discuter" if has_data else "Importez des données pour commencer"),
    disabled=not ready,
)

if not has_data:
    render_welcome(ready_engine)
else:
    render_header(ready_engine, engine_label, engine_pill)
    if ss.pop("goto_chat", False) or typed:
        ss.main_tab = TABS[0]
    tab_chat, tab_explore, tab_quality, tab_data = st.tabs(TABS, key="main_tab", on_change="rerun")

    pending = None
    if ss.queued:
        pending = (ss.queued, ss.get("queued_label") or ss.queued)
        ss.queued = None
    elif typed:
        pending = (typed, typed)

    with tab_chat:
        if ss.transcript:
            render_quick_popover(ready)
            render_transcript()
        elif not pending:
            render_suggestions(ready)
        if pending and ready:
            prompt, shown = pending
            process_message(prompt, shown)
    with tab_explore:
        render_exploration()
    with tab_quality:
        render_quality()
    with tab_data:
        render_data()
