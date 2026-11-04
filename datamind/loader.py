"""Chargement de fichiers de données hétérogènes en ``pandas.DataFrame``.

Formats : CSV, TSV, TXT, Excel (.xlsx/.xls, choix de la feuille), JSON, JSON Lines, Parquet.
Pour les fichiers texte, l'encodage et le séparateur sont détectés automatiquement,
y compris le format français (point-virgule et virgule décimale).
Les colonnes qui ressemblent à des dates sont converties en ``datetime``.
"""

from __future__ import annotations

import csv
import io
import re
import warnings
from pathlib import Path

import pandas as pd

SUPPORTED_EXTENSIONS = (".csv", ".tsv", ".txt", ".xlsx", ".xls", ".json", ".jsonl", ".parquet")

_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")
_DATE_NAME = re.compile(r"(date|jour|day|mois|month|time|horodat|timestamp|period|p[ée]riode)", re.I)


class DataLoadError(Exception):
    """Erreur lisible par l'utilisateur lors du chargement d'un fichier."""


# --------------------------------------------------------------------------- #
# Texte (CSV / TSV / TXT)
# --------------------------------------------------------------------------- #
def _decode(raw: bytes) -> str:
    for encoding in _ENCODINGS:
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise DataLoadError("Encodage du fichier non reconnu (essayez de l'enregistrer en UTF-8).")


def _sniff_separator(text: str) -> str:
    sample = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        counts = {sep: sample.count(sep) for sep in (";", ",", "\t", "|")}
        return max(counts, key=counts.get)


def _read_text(raw: bytes) -> pd.DataFrame:
    text = _decode(raw)
    if not text.strip():
        raise DataLoadError("Le fichier est vide.")
    sep = _sniff_separator(text)
    # Point-virgule => export Excel français : la virgule est alors le séparateur décimal.
    decimal = "," if sep == ";" else "."
    try:
        return pd.read_csv(io.StringIO(text), sep=sep, decimal=decimal, thousands=None)
    except Exception as exc:  # noqa: BLE001
        try:
            return pd.read_csv(io.StringIO(text), sep=None, engine="python")
        except Exception:  # noqa: BLE001
            raise DataLoadError(f"Impossible de lire le fichier texte : {exc}") from exc


# --------------------------------------------------------------------------- #
# Excel
# --------------------------------------------------------------------------- #
def excel_sheets(raw: bytes) -> list[str]:
    """Noms des feuilles d'un classeur Excel (liste vide si illisible)."""
    try:
        return list(pd.ExcelFile(io.BytesIO(raw)).sheet_names)
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------------------- #
# Post-traitement
# --------------------------------------------------------------------------- #
def _clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    cols, seen = [], {}
    for i, col in enumerate(df.columns):
        name = str(col).strip() or f"colonne_{i + 1}"
        if name.startswith("Unnamed:"):
            name = f"colonne_{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        cols.append(name)
    df.columns = cols
    return df


def coerce_dates(df: pd.DataFrame) -> pd.DataFrame:
    """Convertit en dates les colonnes texte dont le nom ou le contenu l'indique."""
    for col in df.columns:
        series = df[col]
        if not (pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)):
            continue
        sample = series.dropna().astype(str).head(200)
        if sample.empty:
            continue
        looks_like_date = bool(_DATE_NAME.search(col)) or sample.str.match(
            r"^\d{4}-\d{2}-\d{2}|^\d{1,2}/\d{1,2}/\d{2,4}").mean() > 0.8
        if not looks_like_date:
            continue
        iso = sample.str.match(r"^\d{4}-\d{2}-\d{2}").mean() > 0.8
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = pd.to_datetime(series, errors="coerce", dayfirst=not iso)
        if parsed.notna().sum() >= 0.9 * series.notna().sum():
            df[col] = parsed
    return df


# --------------------------------------------------------------------------- #
# Point d'entrée
# --------------------------------------------------------------------------- #
def load_dataframe(file_name: str, raw: bytes, sheet: str | int | None = None) -> pd.DataFrame:
    """Charge ``raw`` en DataFrame selon l'extension de ``file_name``.

    ``sheet`` : feuille Excel à lire (la première par défaut).
    Lève ``DataLoadError`` avec un message explicite en cas d'échec.
    """
    suffix = Path(file_name).suffix.lower()
    try:
        if suffix in (".csv", ".tsv", ".txt"):
            df = _read_text(raw)
        elif suffix in (".xlsx", ".xls"):
            df = pd.read_excel(io.BytesIO(raw), sheet_name=sheet if sheet is not None else 0)
        elif suffix == ".jsonl":
            df = pd.read_json(io.BytesIO(raw), lines=True)
        elif suffix == ".json":
            try:
                df = pd.read_json(io.BytesIO(raw))
            except ValueError:
                try:
                    df = pd.read_json(io.BytesIO(raw), lines=True)
                except ValueError:
                    import json

                    df = pd.json_normalize(json.loads(_decode(raw)))
        elif suffix == ".parquet":
            df = pd.read_parquet(io.BytesIO(raw))
        else:
            raise DataLoadError(
                f"Format non pris en charge : « {suffix or file_name} ». "
                f"Formats acceptés : {', '.join(SUPPORTED_EXTENSIONS)}."
            )
    except DataLoadError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DataLoadError(f"Échec du chargement de « {file_name} » : {exc}") from exc

    if df is None or df.shape[1] == 0:
        raise DataLoadError("Le fichier ne contient aucune colonne exploitable.")
    if df.shape[0] == 0:
        raise DataLoadError("Le fichier ne contient aucune ligne de données.")

    df = _clean_columns(df)
    return coerce_dates(df)
