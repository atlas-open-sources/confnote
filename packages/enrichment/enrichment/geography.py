"""Bounded offline gazetteer. Unmatched or conflicting places remain unknown."""

import re
import unicodedata
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

# City, ISO 3166-1 country, IANA zone, aliases, country context required.
# Ambiguous names require an explicit country/region in the source.
CITIES = (
    ("San Francisco", "US", "America/Los_Angeles", ("san francisco",), False),
    ("Chicago", "US", "America/Chicago", ("chicago",), False),
    ("Minneapolis", "US", "America/Chicago", ("minneapolis",), False),
    ("Chennai", "IN", "Asia/Kolkata", ("chennai",), False),
    ("Rome", "IT", "Europe/Rome", ("rome", "roma"), True),
    ("Melbourne", "AU", "Australia/Melbourne", ("melbourne",), True),
    ("Opatija", "HR", "Europe/Zagreb", ("opatija",), False),
    ("Kagoshima", "JP", "Asia/Tokyo", ("kagoshima",), False),
    ("Okayama", "JP", "Asia/Tokyo", ("okayama",), False),
    ("Yokohama", "JP", "Asia/Tokyo", ("yokohama",), False),
    ("Fukuoka", "JP", "Asia/Tokyo", ("fukuoka",), False),
    ("Tokyo", "JP", "Asia/Tokyo", ("tokyo",), False),
    ("Aalen", "DE", "Europe/Berlin", ("aalen",), False),
    ("Seoul", "KR", "Asia/Seoul", ("seoul",), False),
    ("Quito", "EC", "America/Guayaquil", ("quito",), False),
    ("Palma", "ES", "Europe/Madrid", ("palma", "palma de mallorca"), True),
    ("Bogotá", "CO", "America/Bogota", ("bogota",), False),
    ("Barcelona", "ES", "Europe/Madrid", ("barcelona",), False),
    ("Oslo", "NO", "Europe/Oslo", ("oslo",), False),
    ("Stockholm", "SE", "Europe/Stockholm", ("stockholm",), False),
    ("London", "GB", "Europe/London", ("london",), True),
    ("Sydney", "AU", "Australia/Sydney", ("sydney",), True),
    ("Santiago", "CL", "America/Santiago", ("santiago",), True),
    ("Vancouver", "CA", "America/Vancouver", ("vancouver",), True),
    ("San Diego", "US", "America/Los_Angeles", ("san diego",), False),
    ("Belo Horizonte", "BR", "America/Sao_Paulo", ("belo horizonte",), False),
    ("Bengaluru", "IN", "Asia/Kolkata", ("bengaluru", "bangalore"), False),
    ("Hyderabad", "IN", "Asia/Kolkata", ("hyderabad",), True),
    ("Prague", "CZ", "Europe/Prague", ("prague", "praha"), False),
    ("Pittsburgh", "US", "America/New_York", ("pittsburgh",), False),
)
COUNTRIES = {
    "IT": ("italy", "italia"),
    "HR": ("croatia", "hrvatska"),
    "JP": ("japan",),
    "DE": ("germany", "deutschland"),
    "KR": ("south korea", "republic of korea"),
    "EC": ("ecuador",),
    "ES": ("spain", "espana"),
    "CO": ("colombia",),
    "NO": ("norway",),
    "SE": ("sweden",),
    "GB": ("uk", "united kingdom", "great britain", "england"),
    "AU": ("australia",),
    "CL": ("chile",),
    "CA": ("canada",),
    "US": (
        "usa",
        "u.s.a.",
        "united states",
    ),
    "BR": ("brazil", "brasil"),
    "IN": ("india",),
    "CZ": ("czechia", "czech republic"),
}


def normalized(value: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFKD", value.casefold())
        if not unicodedata.combining(char)
    )


def contains(value: str, phrase: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", value) is not None


def resolve_place(location: str, summary: str) -> tuple[dict, str | None]:
    """Return geography plus the source property supporting the city match."""
    location_text, summary_text = normalized(location), normalized(summary)
    if any(contains(location_text, word) for word in ("online", "virtual", "remote")) or re.search(
        r"https?://[^ /]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)", location_text
    ):
        return {"attendance_mode": "online", "timezone": None}, "LOCATION"
    if any(contains(summary_text, word) for word in ("online", "virtual")):
        return {"attendance_mode": "online", "timezone": None}, "SUMMARY"
    combined = location_text + " " + summary_text
    country_matches = {
        code for code, names in COUNTRIES.items() if any(contains(combined, name) for name in names)
    }
    matches = []
    for city, country, timezone, aliases, requires_country in CITIES:
        locator = None
        if any(contains(location_text, alias) for alias in aliases):
            locator = "LOCATION"
        elif any(contains(summary_text, alias) for alias in aliases):
            locator = "SUMMARY"
        if locator and (not requires_country or country in country_matches):
            if country_matches and country_matches != {country}:
                continue
            matches.append(
                (
                    {
                        "city": city,
                        "country": country,
                        "timezone": timezone,
                        "attendance_mode": "offline",
                    },
                    locator,
                )
            )
    if len(matches) != 1:
        return {}, None
    return matches[0]


def event_status(
    end: str, source_status: str | None, *, now: datetime | None = None, timezone: str | None = None
) -> str:
    if source_status and source_status.upper() in ("CANCELLED", "CANCELED"):
        return "cancelled"
    if source_status and source_status.upper() == "POSTPONED":
        return "postponed"
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("status clock must be timezone-aware")
    if len(end) == 10:
        zone = ZoneInfo(timezone) if timezone else UTC
        boundary = datetime.combine(
            datetime.fromisoformat(end).date() + timedelta(days=1), time.min, zone
        )
    else:
        boundary = datetime.fromisoformat(end.replace("Z", "+00:00"))
    return "completed" if boundary <= now else "scheduled"
