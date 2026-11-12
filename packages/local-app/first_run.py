"""Non-destructive public starter agenda for a fresh local vault."""

import json
import sys
from collections.abc import Callable
from pathlib import Path


def starter_agenda_path() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "tools" / "devday-2026.json"
    return Path(__file__).resolve().parents[2] / "tools" / "devday-2026.json"


def seed_first_run(base_dir: Path, create_conference: Callable[[dict], str]) -> bool:
    """Seed only an empty vault; hidden app state does not count as user content.

    The caller owns normal manifest validation and note generation. Any visible
    file/folder causes a skip, so selecting an existing vault never imports data.
    """
    base_dir = Path(base_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    if any(not entry.name.startswith(".") for entry in base_dir.iterdir()):
        return False
    create_conference(json.loads(starter_agenda_path().read_text(encoding="utf-8")))
    return True
