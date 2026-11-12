import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "packages/enrichment"), str(ROOT / "packages/events-model/python")]
