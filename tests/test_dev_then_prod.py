"""Exercise delivery ordering without building or touching installed applications."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/dev-then-prod.sh"


@pytest.fixture
def delivery(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copyfile(SCRIPT, scripts / SCRIPT.name)
    binaries = tmp_path / "bin"
    binaries.mkdir()
    python = tmp_path / "packages/local-app/.venv/bin/python"
    python.parent.mkdir(parents=True)
    log = tmp_path / "calls"
    commands = {
        binaries / "make": 'echo "make $*" >> "$CALLS"\n[ "$1" != "${FAIL_STAGE:-}" ]',
        binaries / "open": 'echo "open $*" >> "$CALLS"',
        python: 'echo "smoke $CONFNOTE_TEST_APP" >> "$CALLS"',
    }
    for path, text in commands.items():
        path.write_text("#!/bin/sh\n" + text + "\n")
        path.chmod(0o755)
    env = {**os.environ, "PATH": f"{binaries}:{os.environ['PATH']}", "CALLS": str(log)}

    def run(answer, fail=""):
        result = subprocess.run(
            ["sh", str(scripts / SCRIPT.name)],
            input=answer,
            text=True,
            capture_output=True,
            env={**env, "FAIL_STAGE": fail, "DEV_TAG": "test-tag"},
        )
        return result, log.read_text().splitlines()

    return run


def test_dev_acceptance_then_prod_order(delivery):
    result, calls = delivery("prod\n")
    assert result.returncode == 0
    assert calls == [
        "make lint",
        "make e2e",
        "make test-web",
        "make app-dev DEV_TAG=test-tag",
        "smoke /Applications/confnote dev.app",
        "open /Applications/confnote dev.app",
        "make app-prod",
        "smoke /Applications/confnote.app",
        "open /Applications/confnote.app",
    ]


@pytest.mark.parametrize("answer", ["no\n", ""])
def test_decline_or_eof_leaves_prod_untouched(delivery, answer):
    result, calls = delivery(answer)
    assert result.returncode == 0
    assert "make app-prod" not in calls
    assert "Stopped after dev" in result.stdout


@pytest.mark.parametrize("stage", ["lint", "e2e", "test-web", "app-dev"])
def test_failed_gate_stops_before_prod(delivery, stage):
    result, calls = delivery("prod\n", fail=stage)
    assert result.returncode != 0
    assert "make app-prod" not in calls
    assert not any(call.startswith("smoke") for call in calls)
