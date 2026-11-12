#!/usr/bin/env python3
"""Check a whisper word-timestamp transcript against the placed voiceover blocks.

usage: check_transcript.py <blocks.json> <placement.json> <whisper.json>
For each block: the words whisper heard inside its placed span, a word-match ratio
against the script text, and whether any heard word falls outside every block span.
"""

import difflib
import json
import re
import sys
from pathlib import Path

SLOP = 0.30  # s of timestamp tolerance around a placed span


def words(text: str) -> list[str]:
    text = text.lower().replace("402", "four oh two").replace("&", "and").replace("-", " ")
    return re.findall(r"[a-z0-9']+", text.replace("’", "'"))


def main() -> None:
    blocks = {b["n"]: b for b in json.loads(Path(sys.argv[1]).read_text())}
    placed = json.loads(Path(sys.argv[2]).read_text())
    heard = [
        w for seg in json.loads(Path(sys.argv[3]).read_text())["segments"] for w in seg["words"]
    ]
    used = set()
    worst = 1.0
    for line in placed:
        inside = [
            i
            for i, w in enumerate(heard)
            if line["on"] - SLOP <= w["start"] and w["end"] <= line["off"] + SLOP
        ]
        used.update(inside)
        got = " ".join(heard[i]["word"].strip() for i in inside)
        ratio = difflib.SequenceMatcher(None, words(blocks[line["n"]]["text"]), words(got)).ratio()
        worst = min(worst, ratio)
        print(f"{line['n']:2d} {line['on']:7.2f}-{line['off']:7.2f} match {ratio:.2f}  {got}")
    stray = [w for i, w in enumerate(heard) if i not in used]
    for w in stray:
        print(f"STRAY {w['start']:.2f}-{w['end']:.2f} {w['word']}")
    print(f"worst match {worst:.2f}, {len(stray)} stray words")


if __name__ == "__main__":
    main()
