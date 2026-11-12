#!/usr/bin/env python3
"""Privacy gate for a demo cut: OCR every frame at a fixed rate and look for account identifiers and emails.

usage: privacy_gate.py <video.mp4> <work dir> [--fps 4] [--identifier TEXT ...]

Identifiers: the account email in CONFNOTE_DEMO_EMAIL (its full address, its local part and its domain) plus any
--identifier. Emails: any x@domain.tld outside the sandbox domains in ALLOWED_EMAIL_DOMAINS. OCR often reads a
zero as "@" inside digits ("2026-@5-19"); those are not email-shaped (no dotted domain) and are not hits.
Exit 0 = every frame was read and nothing was found; exit 1 = look at the hits.

Needs ffmpeg and tesseract on PATH.
"""

import argparse
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ALLOWED_EMAIL_DOMAINS = ("example.org", "example.com")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
OCR_WORKERS = 8


def identifiers_from(email: str, extra: list[str]) -> list[str]:
    found = [x for x in extra if x]
    if email:
        local, _, domain = email.partition("@")
        found += [email, local, domain]
    return sorted({x.lower() for x in found if len(x) >= 4})


def allowed(address: str) -> bool:
    domain = address.rsplit("@", 1)[1].lower()
    # OCR can clip the end of a sandbox domain ("example.o"); only the sandbox names are let through.
    return any(domain.startswith(sandbox[:9]) for sandbox in ALLOWED_EMAIL_DOMAINS)


def scan(lines: list[str], identifiers: list[str]) -> dict[str, list[str]]:
    """Sort OCR lines into identifier hits, email hits and sandbox emails."""
    hits: dict[str, list[str]] = {"identifiers": [], "emails": [], "sandbox": []}
    for line in lines:
        lowered = line.lower()
        if any(identifier in lowered for identifier in identifiers):
            hits["identifiers"].append(line)
        for address in EMAIL.findall(line):
            hits["sandbox" if allowed(address) else "emails"].append(line)
    return hits


def ocr(frame: Path) -> list[str]:
    out = subprocess.run(
        ["tesseract", str(frame), "stdout", "--psm", "11"], capture_output=True, text=True
    )
    return [line for line in out.stdout.splitlines() if line.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("work", type=Path)
    ap.add_argument("--fps", type=float, default=4)
    ap.add_argument("--identifier", action="append", default=[])
    args = ap.parse_args()

    identifiers = identifiers_from(os.environ.get("CONFNOTE_DEMO_EMAIL", ""), args.identifier)
    if not identifiers:
        sys.exit("set CONFNOTE_DEMO_EMAIL (the recording account) or pass --identifier")
    frames_dir = args.work / "ocr"
    frames_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(args.video),
            "-vf",
            f"fps={args.fps}",
            str(frames_dir / "g%05d.png"),
        ],
        check=True,
    )
    frames = sorted(frames_dir.glob("g*.png"))
    with ThreadPoolExecutor(OCR_WORKERS) as pool:
        texts = list(pool.map(ocr, frames))
    lines = [
        f"{frame.name}: {line}" for frame, text in zip(frames, texts, strict=True) for line in text
    ]
    hits = scan(lines, identifiers)
    print(f"frames: {len(frames)}, OCR'd: {len(texts)}, identifiers checked: {len(identifiers)}")
    print(f"sandbox emails: {len(hits['sandbox'])}")
    for kind in ("identifiers", "emails"):
        print(f"--- {kind} ---")
        print("\n".join(hits[kind]) or "none")
    sys.exit(1 if hits["identifiers"] or hits["emails"] or len(texts) != len(frames) else 0)


if __name__ == "__main__":
    main()
