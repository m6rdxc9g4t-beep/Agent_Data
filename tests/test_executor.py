from datamind.executor import build_namespace, execute_python


def test_runs_code_and_keeps_variables(ventes):
    ns = build_namespace(ventes)
    r = execute_python("total = df['montant'].sum()\nprint(round(total, 2))", ns, ventes)
    assert not r.is_error
    assert r.output.strip() == str(round(ventes["montant"].sum(), 2))
    r2 = execute_python("print(total > 0)", ns, ventes)
    assert r2.output.strip() == "True"


def test_captures_figures(ventes):
    ns = build_namespace(ventes)
    r = execute_python("df.groupby('region')['montant'].sum().plot.bar()", ns, ventes)
    assert len(r.figures) == 1 and r.figures[0][:4] == b"\x89PNG"
    assert "figure" in r.output


def test_error_returns_traceback(ventes):
    r = execute_python("df['inexistante']", build_namespace(ventes), ventes)
    assert r.is_error and "KeyError" in r.output


def test_timeout_interrupts_long_code():
    r = execute_python("def f():\n    pass\nwhile True:\n    f()", build_namespace(None), None, timeout=0.5)
    assert r.is_error and "interrompue" in r.output
    assert r.duration < 5


def test_df_can_be_transformed_but_original_is_kept(ventes):
    ns = build_namespace(ventes)
    execute_python("df = df[df['region'] == 'Nord']", ns, ventes)
    r = execute_python("print(len(df), len(df_original))", ns, ventes)
    n_nord = int((ventes["region"] == "Nord").sum())
    assert r.output.split() == [str(n_nord), str(len(ventes))]
    # df écrasé par autre chose qu'un DataFrame : restauré
    execute_python("df = 3", ns, ventes)
    assert len(execute_python("print(len(df))", ns, ventes).output.strip()) > 0


def test_output_is_truncated():
    r = execute_python("print('x' * 50000)", build_namespace(None), None)
    assert len(r.output) < 13000 and "tronquée" in r.output
