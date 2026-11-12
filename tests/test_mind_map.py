"""draw_mind_map: the spec builder (shared fixture with the hosted twin), the
Mac tool over a real tmp vault, and the drawer's layout (mind-map.js, run in node).

The hosted twin is packages/web-app/test/mind-map.test.ts."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, "packages/local-app")
import concierge_tools  # noqa: E402
import server  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((REPO / "packages/contracts/fixtures/mind-map.json").read_text())
LAYOUT_JS = REPO / "packages/core-ui/static/modules/tldraw/mind-map.js"
SLUG = "2026-11-03-map-conf"


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_spec_matches_the_shared_fixture(case):
    options = case["options"]
    spec = concierge_tools.build_mind_map_spec(
        FIXTURE["slug"],
        FIXTURE["conference"],
        FIXTURE["events"],
        FIXTURE["notes"],
        day=options.get("day"),
        file=options.get("file"),
        branches=options.get("branches"),
        now=datetime.fromisoformat(case["now"]),
    )
    assert spec.pop("id").startswith(f"map-{case['expected']['day']}-")
    assert spec == case["expected"]


def test_key_points_strip_markdown_and_stop_at_sources():
    text = (
        "## Heading\n"
        "- [x] **Ship** the [demo](https://x.dev). Then rest.\n"
        "> quoted line\n"
        "https://only-a-url.example\n"
        "1. numbered point\n"
        "### Sources\n"
        "- after sources\n"
    )
    assert concierge_tools.key_points(text, 5) == ["Ship the demo", "quoted line", "numbered point"]
    assert concierge_tools.key_points(text, 1) == ["Ship the demo"]
    long = "word " * 40
    clipped = concierge_tools.key_points(long, 1)[0]
    assert len(clipped) <= concierge_tools.MAP_POINT_CHARS and clipped.endswith("…")


def test_unknown_session_and_empty_conference_are_errors():
    assert "error" in concierge_tools.build_mind_map_spec("s", {"name": "X"}, [], {})
    missing = concierge_tools.build_mind_map_spec(
        FIXTURE["slug"], FIXTURE["conference"], FIXTURE["events"], {}, file="nope.md"
    )
    assert missing["error"].startswith("No session nope.md")


# ---------- the Mac tool over a real vault ----------


def _manifest():
    def event(eid, title, start, tags, speakers=(), kind="talk"):
        return {
            "id": eid,
            "type": kind,
            "title": title,
            "start": f"2026-11-03T{start}:00+00:00",
            "end": f"2026-11-03T{start[:2]}:45:00+00:00",
            "room": "main",
            "tags": list(tags),
            "speakers": list(speakers),
        }

    return {
        "schema_version": "confnote.agenda.v1",
        "conference": {"name": "Map Conf", "date": "2026-11-03", "timezone": "Europe/London"},
        "rooms": [{"id": "main", "name": "Main"}],
        "events": [
            event("agents", "Agents at Scale", "09:00", ["agents", "scale"], ["ada"]),
            event("evals", "Evals in Practice", "10:00", ["agents", "evals"]),
            event("css", "Fast CSS", "11:00", ["css"]),
            event("lunch", "Lunch", "12:00", [], kind="lunch"),
        ],
        "speakers": {"ada": {"name": "Ada Lovelace", "company": "Engines"}},
    }


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    server.create_conference(_manifest())
    return tmp_path


def test_tool_maps_the_notes_without_seed_hints_and_opens_the_canvas(vault):
    note = next((vault / SLUG / "notes").glob("*-agents.md"))
    text = note.read_text().replace(
        "## Human notes\n", "## Human notes\n\n- Batch the tool calls\n- Cache the plans\n", 1
    )
    note.write_text(text)
    events = []
    tools = concierge_tools.LocalTools(slug=SLUG, emit=events.append)
    result = tools.call("draw_mind_map", {})
    assert result["ok"] and result["center"] == "Map Conf"
    assert result["topics"] == ["Agents", "Css"]
    saved = json.loads((vault / SLUG / ".confnote/modules/tldraw-board.json").read_text())
    assert saved["kind"] == "mindmap" and saved["id"] == result["map"]
    agents = saved["branches"][0]["leaves"]
    assert {"text": "Batch the tool calls", "kind": "point"} in agents
    assert {"text": "Ada Lovelace", "kind": "speaker"} in agents
    # The importer's seeded Summary / Research hints never become points.
    assert not any("seeded" in leaf["text"] or "dossier" in leaf["text"] for leaf in agents)
    assert {"open_module": "tldraw"} in events


def test_tool_rejects_arguments_outside_the_spec(vault):
    tools = concierge_tools.LocalTools(slug=SLUG)
    too_many = [{"topic": f"t{i}", "points": ["p"]} for i in range(8)]
    assert tools.call("draw_mind_map", {"branches": too_many})["error"].startswith(
        "Invalid arguments"
    )
    assert tools.call("draw_mind_map", {"branches": [{"points": ["p"]}]})["error"].startswith(
        "Invalid arguments"
    )


# ---------- the drawer's layout, in node ----------

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def layout(sizes: dict) -> dict:
    source = (
        f"const M = require({json.dumps(str(LAYOUT_JS))});\n"
        "process.stdout.write(JSON.stringify(M.layoutMindMap(JSON.parse(process.argv[1]))));"
    )
    done = subprocess.run(
        ["node", "-e", source, json.dumps(sizes)], capture_output=True, text=True, check=True
    )
    return json.loads(done.stdout)


def _sizes(leaf_counts, leaf_h=40):
    return {
        "center": {"w": 300, "h": 104},
        "branches": [
            {"w": 200, "h": 56, "leaves": [{"w": 240, "h": leaf_h + 8 * j} for j in range(n)]}
            for n in leaf_counts
        ],
    }


def _boxes(sizes, placed):
    yield ("center", placed["center"]["x"], placed["center"]["y"], sizes["center"])
    for i, (size, spot) in enumerate(zip(sizes["branches"], placed["branches"], strict=True)):
        yield (f"b{i}", spot["x"], spot["y"], size)
        for j, (leaf, pos) in enumerate(zip(size["leaves"], spot["leaves"], strict=True)):
            yield (f"b{i}l{j}", pos["x"], pos["y"], leaf)


@needs_node
@pytest.mark.parametrize("counts", [[3], [2, 5], [7, 1, 4, 4, 2, 6, 3], [0, 2, 2]])
def test_layout_never_overlaps(counts):
    sizes = _sizes(counts)
    boxes = list(_boxes(sizes, layout(sizes)))
    for i, (a, ax, ay, asz) in enumerate(boxes):
        for b, bx, by, bsz in boxes[i + 1 :]:
            apart = (
                ax + asz["w"] <= bx
                or bx + bsz["w"] <= ax
                or ay + asz["h"] <= by
                or by + bsz["h"] <= ay
            )
            assert apart, f"{a} overlaps {b}"


@needs_node
def test_layout_is_radial_around_the_centre():
    sizes = _sizes([3, 3, 3, 3, 3])
    placed = layout(sizes)
    center = placed["center"]
    sides = [spot["side"] for spot in placed["branches"]]
    assert sides == ["right", "right", "right", "left", "left"]
    for size, spot in zip(sizes["branches"], placed["branches"], strict=True):
        if spot["side"] == "right":
            assert spot["x"] > center["x"] + sizes["center"]["w"]
            assert all(leaf["x"] > spot["x"] + size["w"] for leaf in spot["leaves"])
        else:
            assert spot["x"] + size["w"] < center["x"]
            assert all(leaf["x"] + 240 < spot["x"] for leaf in spot["leaves"])
    right = placed["branches"][:3]
    # The middle branch reaches further out than the top and bottom ones: a curve, not a column.
    assert right[1]["x"] > right[0]["x"] and right[1]["x"] > right[2]["x"]
    # Clockwise: right side top to bottom, then the left side bottom to top.
    assert right[0]["y"] < right[1]["y"] < right[2]["y"]
    assert placed["branches"][3]["y"] > placed["branches"][4]["y"]
