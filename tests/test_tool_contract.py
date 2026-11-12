"""Concierge tool parity, Mac side: packages/contracts/tools.json is the one
tool set, and every Mac provider serves exactly it.

The hosted half is packages/web-app/test/tool-contract.test.ts, checked
against the same file, so the two hosts cannot drift apart: a tool that is
added, dropped or re-shaped on one host without the spec (or an explicit
not_on / native entry with its reason) fails one of the two.
"""

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "packages/local-app"))
import chat  # noqa: E402
import chatgpt_agent  # noqa: E402
import concierge_tools  # noqa: E402

SPEC = json.loads((REPO / "packages/contracts/tools.json").read_text())
NAMES = [tool["name"] for tool in SPEC["tools"]]
HOSTS = {"local", "local:claude", "local:chatgpt", "hosted"}
LOCAL_HOSTS = ("local:claude", "local:chatgpt")
SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")


def _params(schema):
    yield from schema.get("properties", {})
    for prop in schema.get("properties", {}).values():
        items = prop.get("items", {})
        if items.get("type") == "object":
            yield from _params(items)


def test_the_spec_is_one_well_formed_tool_set():
    assert SPEC["version"] == "confnote.tools.v2"
    assert len(NAMES) == len(set(NAMES))
    for tool in SPEC["tools"]:
        assert SNAKE.match(tool["name"]), tool["name"]
        assert tool["access"] in ("read", "write", "network"), tool["name"]
        assert tool["purpose"].strip() and tool["result"].strip(), tool["name"]
        schema = tool["input_schema"]
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert set(schema.get("required", [])) <= set(schema["properties"]), tool["name"]
        assert all(SNAKE.match(p) for p in _params(schema)), tool["name"]
    for kind in ("not_on", "native", "conditional"):
        for entry in SPEC[kind]:
            assert entry["tool"] in NAMES and entry["host"] in HOSTS, entry
            assert len(entry["reason"]) > 20, entry


def test_network_tools_label_their_output_untrusted():
    for tool in SPEC["tools"]:
        if tool["access"] == "network":
            assert tool.get("untrusted_output") is True, tool["name"]


@pytest.mark.parametrize("host", LOCAL_HOSTS)
def test_each_mac_provider_serves_the_spec_minus_its_listed_exceptions(host):
    registry = concierge_tools.LocalTools(host=host)
    served = set(registry.served())
    excused = set(concierge_tools.host_entries("not_on", host)) | set(
        concierge_tools.host_entries("native", host)
    )
    assert served | excused == set(NAMES)
    assert not served & excused
    # Every served tool has an implementation; a spec tool without one must be
    # excused (not_on or native) on every Mac provider.
    implemented = {n for n in NAMES if callable(getattr(concierge_tools.LocalTools, n, None))}
    assert served <= implemented
    for name in set(NAMES) - implemented:
        for other in LOCAL_HOSTS:
            assert name in set(concierge_tools.host_entries("not_on", other)) | set(
                concierge_tools.host_entries("native", other)
            ), (name, other)


def test_claude_gets_the_spec_names_purposes_and_schemas():
    registry = concierge_tools.LocalTools(host="local:claude")
    tools = {t.name: t for t in chat.conf_tools(registry)}
    assert set(tools) == set(registry.served())
    for name, sdk_tool in tools.items():
        entry = concierge_tools.tool_spec(name)
        assert sdk_tool.description == entry["purpose"]
        assert sdk_tool.input_schema == entry["input_schema"]
    # web_search is the SDK's own WebSearch on the Mac, allowed by that name.
    assert concierge_tools.host_entries("native", "local:claude")["web_search"]["as"] == "WebSearch"


def test_chatgpt_gets_the_spec_and_stays_offline():
    registry = concierge_tools.LocalTools(host="local:chatgpt")
    defs, callbacks = chatgpt_agent.registry_tools(registry)
    names = {d["name"] for d in defs}
    assert names == set(callbacks) == set(registry.served())
    assert not names & {"web_search", "fetch_url", "import_conference_from_url"}
    for d in defs:
        assert d["parameters"] == concierge_tools.tool_spec(d["name"])["input_schema"]
        assert d["description"] == concierge_tools.tool_spec(d["name"])["purpose"]


def test_hosted_registry_names_match_the_spec_file():
    """The cheap cross-check from this side: the hosted registry names every
    spec tool it does not list in not_on (its test checks schemas too)."""
    source = (REPO / "packages/web-app/lib/concierge-tools.ts").read_text()
    hosted = set(re.findall(r"^  ([a-z][a-z0-9_]*): async \(", source, re.M))
    excused = {e["tool"] for e in SPEC["not_on"] if e["host"] == "hosted"}
    assert hosted == set(NAMES) - excused


@pytest.mark.parametrize(
    ("schema", "args", "ok"),
    [
        (
            {"required": ["file"], "properties": {"file": {"type": "string"}}},
            {"file": "a.md"},
            True,
        ),
        ({"required": ["file"], "properties": {"file": {"type": "string"}}}, {}, False),
        ({"properties": {"index": {"type": "integer", "minimum": 1}}}, {"index": 0}, False),
        ({"properties": {"index": {"type": "integer"}}}, {"index": True}, False),
        ({"properties": {"name": {"type": "string", "enum": ["BRIEF.md"]}}}, {"name": "x"}, False),
        ({"properties": {}}, {"extra": 1}, False),
    ],
)
def test_arguments_are_checked_against_the_schema(schema, args, ok):
    schema = {"type": "object", "additionalProperties": False, **schema}
    if ok:
        assert concierge_tools.check_args(schema, args) == args
    else:
        with pytest.raises(ValueError):
            concierge_tools.check_args(schema, args)
