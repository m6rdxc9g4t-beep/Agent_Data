import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLES = ROOT / "sample_data"


@pytest.fixture
def ventes() -> pd.DataFrame:
    from datamind.loader import load_dataframe

    return load_dataframe("ventes.csv", (SAMPLES / "ventes.csv").read_bytes())


@pytest.fixture
def clients() -> pd.DataFrame:
    from datamind.loader import load_dataframe

    return load_dataframe("demo_complet.csv", (SAMPLES / "demo_complet.csv").read_bytes())
