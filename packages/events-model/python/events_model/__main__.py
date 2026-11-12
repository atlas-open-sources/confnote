"""Explicit vault-copy migration: python -m events_model /path/to/copied/event."""

import argparse
from pathlib import Path

from .migration import migrate_vault

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
result = migrate_vault(args.directory)
print(f"Migrated {len(result['events'])} sessions; note and asset paths preserved")
