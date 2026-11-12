import json
from pathlib import Path

import server

CONTRACTS = Path(__file__).resolve().parents[1] / "packages" / "contracts"


def _sections_fixture() -> dict:
    return json.loads((CONTRACTS / "fixtures" / "sections.json").read_text())


def test_python_note_parser_matches_contract_fixture():
    case = next(c for c in _sections_fixture()["cases"] if "markdown" in c)

    frontmatter, title, sections = server.parse_note(case["markdown"])

    assert frontmatter == case["frontmatter"]
    assert title == case["title"]
    assert sections == case["sections"]
    assert server.parse_actions(sections["Actions"]) == case["actions"]


def test_python_link_mirror_matches_contract_fixture():
    case = next(c for c in _sections_fixture()["cases"] if "human_notes" in c)

    merged = server.merge_links_into_section(case["human_notes"], case["links_before"])

    assert merged == case["links_after"]
