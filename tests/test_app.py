"""Test de fumée de l'interface (streamlit.testing, sans navigateur ni moteur IA)."""

from pathlib import Path

from streamlit.testing.v1 import AppTest

APP = str(Path(__file__).resolve().parents[1] / "app.py")


def test_app_welcome_then_sample(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")  # injoignable : l'interface doit le dire
    at = AppTest.from_file(APP, default_timeout=60).run()
    assert not at.exception
    assert any("DataMind" in m.value for m in at.markdown)

    next(b for b in at.button if b.label == "Clients").click().run()
    assert not at.exception
    assert at.session_state.df is not None and at.session_state.df.shape[1] == 12
    labels = [t.label for t in at.tabs]
    assert any("Assistant" in label for label in labels) and any("Qualité" in label for label in labels)
    assert at.chat_input[0].disabled  # moteur injoignable : saisie désactivée
