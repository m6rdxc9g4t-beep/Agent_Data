import io

import pandas as pd
import pytest

from datamind.loader import DataLoadError, excel_sheets, load_dataframe


def test_samples_load_with_dates(ventes, clients):
    assert ventes.shape == (30, 8)
    assert clients.shape[1] == 12
    assert pd.api.types.is_datetime64_any_dtype(ventes["date"])
    assert pd.api.types.is_datetime64_any_dtype(clients["date"])


def test_french_csv_semicolon_and_decimal_comma():
    raw = "Date;Ville;Montant\n03/01/2024;Lyon;1 234,5\n04/01/2024;Paris;12,75\n".encode("cp1252")
    df = load_dataframe("export.csv", raw.replace(b"1 234,5", b"1234,5"))
    assert list(df.columns) == ["Date", "Ville", "Montant"]
    assert df["Montant"].tolist() == [1234.5, 12.75]
    assert df["Date"].iloc[0] == pd.Timestamp("2024-01-03")  # jour en premier


def test_tsv_and_latin1():
    raw = "nom\tâge\nÉlodie\t31\n".encode("latin-1")
    df = load_dataframe("a.tsv", raw)
    assert df.loc[0, "nom"] == "Élodie"


def test_json_variants():
    assert load_dataframe("a.json", b'[{"a": 1}, {"a": 2}]').shape == (2, 1)
    assert load_dataframe("a.jsonl", b'{"a": 1}\n{"a": 2}\n').shape == (2, 1)


def test_excel_sheets():
    buf = io.BytesIO()
    with pd.ExcelWriter(buf) as writer:
        pd.DataFrame({"x": [1, 2]}).to_excel(writer, sheet_name="Un", index=False)
        pd.DataFrame({"y": [3]}).to_excel(writer, sheet_name="Deux", index=False)
    raw = buf.getvalue()
    assert excel_sheets(raw) == ["Un", "Deux"]
    assert list(load_dataframe("c.xlsx", raw, sheet="Deux").columns) == ["y"]


def test_duplicate_and_blank_columns_are_renamed():
    df = load_dataframe("d.csv", b"a,a,\n1,2,3\n")
    assert len(set(df.columns)) == 3 and df.columns[2] == "colonne_3"


@pytest.mark.parametrize("name,raw", [("x.pdf", b"%PDF"), ("vide.csv", b""), ("entete.csv", b"a,b\n")])
def test_errors_are_readable(name, raw):
    with pytest.raises(DataLoadError):
        load_dataframe(name, raw)
