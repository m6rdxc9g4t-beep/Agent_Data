import matplotlib.pyplot as plt
import pandas as pd

from datamind import charts
from datamind.profiling import column_kind, profile_columns, quality_report
from datamind.prompts import ALL_ANALYSES, FEATURED, build_system_prompt
from datamind.report import build_html_report, build_markdown_report
from datamind.theme import get_theme


def test_column_kinds(clients):
    assert column_kind(clients["date"]) == "datetime"
    assert column_kind(clients["region"]) == "category"
    assert column_kind(clients["churn"]) == "boolean"
    assert column_kind(clients["depenses_totales"]) == "numeric"
    assert column_kind(pd.Series(range(100))) == "id"
    assert column_kind(pd.Series([1] * 10)) == "constant"


def test_profile_and_quality(clients):
    profile = profile_columns(clients)
    assert len(profile) == clients.shape[1]
    assert profile["Complétude"].between(0, 1).all()
    report = quality_report(clients)
    assert 0 <= report.score <= 100
    assert report.duplicate_rows == int(clients.duplicated().sum())
    assert report.recommendations


def test_quality_flags_problems():
    df = pd.DataFrame({"a": [1, 1, None, None, None], "b": ["1,5", "2", "3", "4", "5"], "c": [7] * 5})
    report = quality_report(pd.concat([df, df.iloc[[0]]]))
    assert report.duplicate_rows == 1
    assert "c" in report.constant_columns
    assert "b" in report.numeric_as_text
    assert report.score < 80


def test_auto_charts(clients, ventes):
    for df in (clients, ventes):
        for dark in (False, True):
            figures = charts.auto_figures(df, get_theme(dark))
            assert len(figures) >= 3
            for _, fig in figures:
                plt.close(fig)
    assert charts.pick_measure(ventes, ["quantite", "prix_unitaire", "montant"]) == ("montant", "sum")
    fig = charts.column_figure(clients, "region", get_theme(False))
    assert fig is not None
    plt.close(fig)


def test_fmt_compact():
    assert charts.fmt_compact(1_234_567) == "1,2 M"
    assert charts.fmt_compact(12_500) == "12,5 k"
    assert charts.fmt_compact(3.14159) == "3,14"


def test_prompts(ventes):
    prompt = build_system_prompt(ventes, "ventes.csv")
    assert "30 lignes" in prompt and "montant" in prompt and "ventes.csv" in prompt
    assert all(k in ALL_ANALYSES for k in FEATURED)


def test_reports():
    transcript = [
        {"role": "user", "text": "Quelle région ?"},
        {"role": "tool", "code": "print(1)", "output": "1", "figures": [b"\x89PNG..."], "is_error": False},
        {"role": "assistant", "text": "**Nord** | x\n\n- point"},
    ]
    page = build_html_report(transcript, "ventes.csv", (30, 8), "Ollama · llama3.1")
    assert "<strong>Nord</strong>" in page and "data:image/png;base64" in page and "Quelle région ?" in page
    md = build_markdown_report(transcript, "ventes.csv")
    assert "## Quelle région ?" in md and "```python" in md
