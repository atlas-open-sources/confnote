"""Planner mapping (modules/bryntum/plan-map.js), run in node.

The Concierge's plan reply → My plan events, and the wallet ledger rows →
Credits events. The model's reply is untrusted: it can only pick listed events
on their own days inside the trip.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MAP_JS = Path(__file__).resolve().parents[1] / "packages/core-ui/static/modules/bryntum/plan-map.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

TRIP = {"city": "London", "from": "2099-06-09", "to": "2099-06-15"}
CANDIDATES = [
    {
        "id": "evt-a",
        "name": "River builders",
        "start": "2099-06-10",
        "end": "2099-06-11",
        "status": "going",
    },
    {
        "id": "evt-b",
        "name": "Small systems",
        "start": "2099-06-11",
        "end": "2099-06-12",
        "status": "",
    },
]


def run(script: str, data) -> object:
    """Run `script` with `M` (the map module) and `data` in scope; it returns JSON."""
    source = (
        f"const M = require({json.dumps(str(MAP_JS))});\n"
        f"const data = JSON.parse(process.argv[1]);\n"
        f"const out = (() => {{ {script} }})();\n"
        "process.stdout.write(JSON.stringify(out));"
    )
    env = {**os.environ, "TZ": "Europe/London"}
    done = subprocess.run(
        ["node", "-e", source, json.dumps(data)],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    return json.loads(done.stdout)


def reply(days) -> str:
    return "Here is your plan:\n```json\n" + json.dumps({"days": days}) + "\n```\n"


def test_plan_reply_maps_to_my_plan_events():
    text = reply(
        [
            {
                "date": "2099-06-10",
                "eventId": "evt-a",
                "start": "10:00",
                "end": "16:30",
                "note": "You are going",
            },
            {
                "date": "2099-06-11",
                "eventId": "evt-b",
                "start": "09:30",
                "end": "12:00",
                "note": "Keynote day",
            },
        ]
    )
    out = run(
        """
        const days = M.parsePlan(data.text, data.trip, data.candidates);
        const events = M.planToEvents(days, data.candidates).map((e) => ({
          id: e.id, resourceId: e.resourceId, name: e.name, why: e.why, cls: e.cls,
          start: M.localDay(e.startDate) + " " + e.startDate.toTimeString().slice(0, 5),
          end: e.endDate.toTimeString().slice(0, 5),
          back: M.eventToPlanDay(e),
        }));
        return { days, events };
        """,
        {"text": text, "trip": TRIP, "candidates": CANDIDATES},
    )
    assert [e["id"] for e in out["events"]] == ["plan:2099-06-10:evt-a", "plan:2099-06-11:evt-b"]
    first = out["events"][0]
    assert first["resourceId"] == "my-plan"
    assert first["name"] == "River builders"
    assert first["start"] == "2099-06-10 10:00"
    assert first["end"] == "16:30"
    assert first["cls"] == "cn-plan"
    # A bar maps back to the stored day unchanged (what a drag or resize saves).
    assert first["back"] == out["days"][0]


def test_plan_reply_drops_unknown_ids_days_off_the_event_or_trip_and_bad_times():
    text = reply(
        [
            {"date": "2099-06-10", "eventId": "evt-zzz", "start": "10:00", "end": "11:00"},
            {"date": "2099-06-13", "eventId": "evt-a", "start": "10:00", "end": "11:00"},
            {"date": "2099-07-01", "eventId": "evt-b", "start": "10:00", "end": "11:00"},
            {"date": "2099-06-12", "eventId": "evt-b", "start": "25:00", "end": "<b>"},
            {"date": "2099-06-12", "eventId": "evt-b", "start": "11:00", "end": "12:00"},
            {
                "date": "2099-06-11",
                "eventId": "evt-a",
                "start": "15:00",
                "end": "14:00",
                "note": "x\n" * 200,
            },
            "not an object",
        ]
    )
    days = run(
        "return M.parsePlan(data.text, data.trip, data.candidates);",
        {"text": text, "trip": TRIP, "candidates": CANDIDATES},
    )
    assert days == [
        # End before start falls back to the default day; the note is one line, capped.
        {
            "date": "2099-06-11",
            "eventId": "evt-a",
            "start": "09:00",
            "end": "17:00",
            "note": ("x " * 200).strip()[:140],
        },
        # Bad times fall back to the default day; the duplicate pick for that day is dropped.
        {"date": "2099-06-12", "eventId": "evt-b", "start": "09:00", "end": "17:00", "note": ""},
    ]


def test_reply_without_a_plan_is_null():
    out = run(
        "return [M.parsePlan('I could not plan that.', data.trip, data.candidates), M.parsePlan('{\"days\": 3}', data.trip, data.candidates)];",
        {"trip": TRIP, "candidates": CANDIDATES},
    )
    assert out == [None, None]


def test_ledger_rows_map_to_credits_events():
    rows = [
        {
            "at": "2026-11-09T00:44:51.646Z",
            "reason": "charge",
            "model": "claude-sonnet-4-6",
            "charged": "-0.0115",
            "balanceAfter": "4.9750",
            "ref": "led-9",
        },
        {
            "at": "2026-11-09T00:44:01.000Z",
            "reason": "purchase",
            "model": None,
            "charged": "5.0000",
            "balanceAfter": "5.0000",
            "ref": "82K50813R58218109",
        },
        {
            "at": "2026-11-09T00:42:35.619Z",
            "reason": "promo",
            "model": None,
            "charged": "2.0000",
            "balanceAfter": "2.0000",
            "ref": "crd_1",
        },
        {"at": "not a date", "reason": "charge", "charged": "-1"},
    ]
    out = run(
        """
        return M.ledgerToEvents(data.rows).map((e) => ({
          resourceId: e.resourceId, name: e.name, kind: e.kind, cls: e.cls,
          at: e.startDate.toISOString(), minutes: (e.endDate - e.startDate) / 60000,
          lines: M.ledgerLines(e),
        }));
        """,
        {"rows": rows},
    )
    assert len(out) == 3
    charge, purchase, promo = out
    assert charge["resourceId"] == "credits"
    assert charge["name"] == "−$0.0115"
    assert charge["kind"] == "charge" and charge["cls"] == "cn-charge"
    assert charge["at"] == "2026-11-09T00:44:51.646Z"
    assert charge["minutes"] == 5
    assert charge["lines"] == [
        "AI step · charge",
        "Amount: −$0.0115",
        "Model: claude-sonnet-4-6",
        "Balance after: $4.9750",
    ]
    assert purchase["name"] == "+$5.00" and purchase["cls"] == "cn-grant"
    assert "PayPal ref: 82K50813R58218109" in purchase["lines"]
    # An internal ledger id is shown as such, never as a PayPal reference.
    assert "Ledger ref: crd_1" in promo["lines"]
    assert not any(line.startswith("PayPal") for line in promo["lines"])
