"""Offline GeoNames lookup. Suggestions are evidence for models, never automatic facts."""

import hashlib
import importlib.metadata
import json
import re
from collections import defaultdict
from pathlib import Path

import geonamescache

from .geography import normalized


def tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", normalized(text), re.UNICODE)


def key(text: str) -> str:
    return " ".join(tokens(text))


class Gazetteer:
    def __init__(self, admin1: Path):
        cache = geonamescache.GeonamesCache(min_city_population=1000)
        self.countries = cache.get_countries()
        self.cities = cache.get_cities()
        self.rows = {}
        self.aliases = defaultdict(set)
        country_zones = defaultdict(set)
        admin_zones = defaultdict(set)
        for city in self.cities.values():
            country_zones[city["countrycode"]].add(city["timezone"])
            admin_zones[city["countrycode"] + "." + city["admin1code"]].add(city["timezone"])
            identifier = str(city["geonameid"])
            self.rows[identifier] = {
                "id": identifier,
                "city": city["name"],
                "country": city["countrycode"],
                "timezone": city["timezone"],
                "admin1": city["admin1code"],
                "population": city["population"],
            }
            for name in [city["name"], *city["alternatenames"]]:
                alias = key(name)
                if len(alias) >= 3:
                    self.aliases[alias].add(identifier)
        for line in admin1.read_text().splitlines():
            code, name, ascii_name, identifier = line.split("\t")
            zones = admin_zones[code] - {""}
            self.rows[identifier] = {
                "id": identifier,
                "region": name,
                "country": code[:2],
                "timezone": next(iter(zones)) if len(zones) == 1 else None,
                "population": 0,
                "admin1": code.split(".")[1],
            }
            for alias in (name, ascii_name):
                self.aliases[key(alias)].add(identifier)
        for code, country in self.countries.items():
            identifier = "country:" + code
            zones = country_zones[code] - {""}
            self.rows[identifier] = {
                "id": identifier,
                "country": code,
                "timezone": next(iter(zones)) if len(zones) == 1 else None,
                "population": country["population"],
            }
            self.aliases[key(country["name"])].add(identifier)
        package = Path(geonamescache.__file__).parent
        self.manifest = {
            "upstream": "https://www.geonames.org/",
            "license": "CC-BY-4.0",
            "mirror": "https://pypi.org/project/geonamescache/3.0.2/",
            "mirror_version": importlib.metadata.version("geonamescache"),
            "admin1_mirror": "https://raw.githubusercontent.com/panchicore/elasticsearch-geonames/master/admin1CodesASCII.txt",
            "city_count": len(self.cities),
            "admin1_count": len(admin1.read_text().splitlines()),
            "sha256": {
                name: hashlib.sha256(path.read_bytes()).hexdigest()
                for name, path in (
                    ("cities1000.json", package / "data/cities1000.json"),
                    ("countries.json", package / "data/countries.json"),
                    ("admin1CodesASCII.txt", admin1),
                )
            },
        }

    def suggest(self, text: str) -> list[dict]:
        words = tokens(text)
        matches = defaultdict(set)
        for start in range(len(words)):
            for size in range(1, min(6, len(words) - start + 1)):
                phrase = " ".join(words[start : start + size])
                for identifier in self.aliases.get(phrase, ()):
                    matches[identifier].add(phrase)
        # Preserve alternatives for ambiguous place names; population is ranking, not proof.
        ranked = sorted(
            matches,
            key=lambda i: (max(len(s.split()) for s in matches[i]), self.rows[i]["population"]),
            reverse=True,
        )
        return [dict(self.rows[i], matched=sorted(matches[i])) for i in ranked[:40]]

    def write_manifest(self, path: Path) -> None:
        path.write_text(json.dumps(self.manifest, indent=2) + "\n")
