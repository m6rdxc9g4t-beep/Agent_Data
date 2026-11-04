"""Boucles agentiques testées avec de faux clients (aucun appel réseau)."""

from types import SimpleNamespace

from datamind.engines.base import STEP_LIMIT_MESSAGE
from datamind.engines.claude import ClaudeEngine
from datamind.engines.ollama import OllamaEngine, extract_code_blocks, extract_text_tool_call
from datamind.executor import build_namespace


# --------------------------------------------------------------------------- #
# Ollama
# --------------------------------------------------------------------------- #
class FakeOllama:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        message = self.replies.pop(0)
        return {"message": message, "prompt_eval_count": 10, "eval_count": 5}


def make_ollama(replies, **kw):
    engine = OllamaEngine(host="http://x", model="m", **kw)
    engine.client = FakeOllama(replies)
    return engine


def collect():
    events = []
    return events, lambda kind, payload: events.append((kind, payload))


def test_ollama_native_tool_call(ventes):
    engine = make_ollama([
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "run_python", "arguments": {"code": "print(len(df))"}}}]},
        {"role": "assistant", "content": "Il y a **30** lignes."},
    ])
    events, on_event = collect()
    messages = [{"role": "user", "content": "combien ?"}]
    usage = engine.run("sys", messages, build_namespace(ventes), ventes, on_event)
    assert [k for k, _ in events] == ["tool", "text"]
    assert events[0][1]["output"].strip() == "30"
    assert messages[2] == {"role": "tool", "content": "30\n", "tool_name": "run_python"}
    assert usage == {"input_tokens": 20, "output_tokens": 10}
    assert engine.client.calls[0]["messages"][0] == {"role": "system", "content": "sys"}


def test_ollama_json_tool_call_in_text(ventes):
    engine = make_ollama([
        {"role": "assistant", "content": '{"name": "run_python", "parameters": {"code": "print(2+2)"}}'},
        {"role": "assistant", "content": "Résultat : 4"},
    ])
    events, on_event = collect()
    engine.run("s", [{"role": "user", "content": "q"}], build_namespace(ventes), ventes, on_event)
    assert events[0][0] == "tool" and events[0][1]["output"].strip() == "4"
    assert events[1] == ("text", "Résultat : 4")


def test_ollama_code_block_fallback_runs_once(ventes):
    block = "Voici le code :\n```python\nprint(df['montant'].max())\n```"
    engine = make_ollama([
        {"role": "assistant", "content": block},
        {"role": "assistant", "content": "Le montant maximal est 2995."},
    ])
    events, on_event = collect()
    messages = [{"role": "user", "content": "max ?"}]
    engine.run("s", messages, build_namespace(ventes), ventes, on_event)
    kinds = [k for k, _ in events]
    assert kinds == ["text", "tool", "text"]
    assert "Résultat de l'exécution" in messages[2]["content"]


def test_ollama_step_limit(ventes):
    call = {"role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": "run_python", "arguments": '{"code": "print(1)"}'}}]}
    engine = make_ollama([call] * 3, max_steps=3)
    events, on_event = collect()
    engine.run("s", [{"role": "user", "content": "q"}], build_namespace(ventes), ventes, on_event)
    assert events[-1] == ("text", STEP_LIMIT_MESSAGE)


def test_text_parsers():
    assert extract_text_tool_call('```json\n{"name": "run_python", "arguments": {"code": "x=1"}}\n```') == "x=1"
    assert extract_text_tool_call("Bonjour") is None
    assert extract_text_tool_call('{"name": "autre", "parameters": {}}') is None
    assert extract_code_blocks("a\n```python\nx = 1\n```\nb\n```py\ny = 2\n```") == "x = 1\n\ny = 2"
    assert extract_code_blocks("pas de code") is None


# --------------------------------------------------------------------------- #
# Claude
# --------------------------------------------------------------------------- #
def block(**kw):
    return SimpleNamespace(**kw)


def response(content, stop):
    usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=50,
                            cache_creation_input_tokens=0)
    return SimpleNamespace(content=content, stop_reason=stop, usage=usage)


class FakeMessages:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.replies.pop(0)


def test_claude_loop_with_tool_use(ventes):
    engine = ClaudeEngine(api_key="sk-test", model="claude-sonnet-5-5")
    fake = FakeMessages([
        response([block(type="text", text="Je calcule."),
                  block(type="tool_use", id="t1", input={"code": "print(df.shape[1])"})], "tool_use"),
        response([block(type="text", text="**8** colonnes.")], "end_turn"),
    ])
    engine.client = SimpleNamespace(messages=fake)
    events, on_event = collect()
    messages = [{"role": "user", "content": "colonnes ?"}]
    usage = engine.run("système", messages, build_namespace(ventes), ventes, on_event)

    assert [k for k, _ in events] == ["text", "tool", "text"]
    tool_result = messages[2]["content"][0]
    assert tool_result["tool_use_id"] == "t1" and tool_result["content"].strip() == "8"
    assert usage == {"input_tokens": 300, "output_tokens": 40}
    first = fake.calls[0]
    assert first["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert first["tools"][0]["name"] == "run_python"
    assert first["thinking"] == {"type": "adaptive"}
