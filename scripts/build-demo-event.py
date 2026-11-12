#!/usr/bin/env python3
"""Build the signed-out demo event: Beyond The Prompt (IET London, 19 May 2026) with musa's notes.

Imports packages/web-app/demo-fixtures/beyond-the-prompt/agenda.json into a fresh temporary vault, puts the
curated session notes from that folder's notes/ in place (musa reviewed and approved them for the public demo
on 2026-11-13: frontmatter, title and "## Human notes" only), runs the local server on it and saves the answers
of the read-only routes the conference view asks for into packages/core-ui/static/demo-event/.
product-shell.js serves them in place of the notebook API when a signed-out visitor picks "Try a demo event".
A session with no curated note keeps only its frontmatter, title and an empty "## Human notes".

usage: packages/local-app/.venv/bin/python scripts/build-demo-event.py
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "packages/core-ui/static/demo-event"
SOURCE = REPO / "packages/web-app/demo-fixtures/beyond-the-prompt"
HUMAN_NOTES = "## Human notes\n"
# Names that were redacted from the curated notes must never come back.
REDACTED = ("Sophia",)
SLUG = "2026-05-19-beyond-the-prompt"
START_TIMEOUT_S = 20


def get(base: str, path: str):
    with urllib.request.urlopen(base + path, timeout=10) as response:
        return json.loads(response.read())


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="confnote-demo-event-") as tmp:
        vault = Path(tmp) / "vault"
        vault.mkdir()
        agenda = json.loads((SOURCE / "agenda.json").read_text())
        # The organiser's contact address stays out of a public page.
        agenda["conference"].pop("contact", None)
        (Path(tmp) / "btp.json").write_text(json.dumps(agenda))
        subprocess.run(
            [
                sys.executable,
                str(REPO / "tools/import_agenda.py"),
                str(Path(tmp) / "btp.json"),
                str(vault),
            ],
            check=True,
            capture_output=True,
        )
        notes = vault / SLUG / "notes"
        curated = {note.name: note.read_text() for note in (SOURCE / "notes").glob("*.md")}
        for note in notes.glob("*.md"):
            if note.name in curated:
                continue
            # Only the template's head: no seeded research or AI sections in the demo.
            head, sep, _ = note.read_text().partition(HUMAN_NOTES)
            note.write_text(head + sep if sep else note.read_text())
        missing = sorted(set(curated) - {note.name for note in notes.glob("*.md")})
        if missing:
            raise SystemExit(f"refusing: curated notes with no session in the agenda: {missing}")
        for name, text in curated.items():
            (notes / name).write_text(text)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        env = {
            **os.environ,
            "CONF_NOTES_DIR": str(vault),
            "CONF_NOTES_PORT": str(port),
            "CONF_NOTES_NOOPEN": "1",
            "CONFNOTE_CATALOGUE_URL": "",
            "CONF_NOTES_NO_KEYCHAIN": "1",
            "PYTHONPATH": str(REPO / "packages/local-app"),
        }
        server = subprocess.Popen(
            [sys.executable, str(REPO / "packages/local-app/server.py")],
            cwd=REPO,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + START_TIMEOUT_S
            while True:
                try:
                    get(base, "/api/conferences")
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.2)
            files = {
                "conferences.json": get(base, "/api/conferences"),
                "conference.json": get(base, f"/api/conference?slug={SLUG}"),
                "conf-doc.json": get(base, f"/api/conf-doc?slug={SLUG}"),
                "actions.json": get(base, f"/api/actions?slug={SLUG}"),
            }
            for note in sorted((vault / SLUG / "notes").glob("*.md")):
                files[f"notes/{note.name}.json"] = get(
                    base, f"/api/note?slug={SLUG}&file={note.name}"
                )
        finally:
            server.terminate()
            server.wait(timeout=5)
        text = json.dumps(files)
        for leak in (tmp, str(Path.home())):
            if leak in text:
                raise SystemExit(f"refusing: the demo data holds {leak!r}")
        for name in REDACTED:
            if name in text:
                raise SystemExit(f"refusing: the demo data names {name!r}, which was redacted")
        email = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)
        if email:
            raise SystemExit(f"refusing: the demo data holds an email address ({email.group(0)})")
    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "notes").mkdir(parents=True)
    for name, payload in files.items():
        (OUT / name).write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(files)} files to {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
