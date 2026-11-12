"""Long speaker text in the sidebar rail must clamp, not bloat the row.

Screenshot #23 showed an active row growing to ~250px tall when the panel
had 4 speakers + affiliations — making the whole agenda unscannable. Clamp
is line-clamp 2 (idle) / 4 (active), CSS-only.
"""

from __future__ import annotations


def test_long_speakers_clamp_non_active(app):
    """Non-active row containing many speakers must clamp to 2 lines."""
    app.locator(".sb-conf").first.click()
    app.wait_for_selector("#sidebar .rl-row")
    # The Beyond The Prompt agenda's panel (15:45) is the worst offender —
    # 4 speakers + affiliations. Verify *some* row's speakers list has >100
    # characters and that it still clamps cleanly.
    bad = app.evaluate(r"""
      () => {
        const rows = [...document.querySelectorAll('#sidebar .rl-row:not(.active) .rl-sp')];
        const long = rows.find(el => el.textContent.length > 100);
        if (!long) return null;
        const cs = getComputedStyle(long);
        return {
          chars: long.textContent.length,
          height: long.getBoundingClientRect().height,
          clamp: cs.webkitLineClamp,
          overflow: cs.overflow,
        };
      }
    """)
    assert bad is not None, "expected at least one row with >100 chars of speakers"
    assert bad["clamp"] == "2"
    assert bad["overflow"] == "hidden"
    # 2 lines @ ~12px font + 1.6 line-height ≈ 40px max. Allow a wide range.
    assert bad["height"] < 60, f"non-active row should clamp ≤2 lines, got {bad['height']}px"


def test_long_speakers_clamp_active(app):
    """Active (open) session is allowed more breathing room — 4 lines.

    The agentic AI panel (15:45) has 4 speakers + affiliations — well over
    100 chars rendered. Pre-clamp this row stretched to ~140px+; the test
    asserts it now fits in ≤4 lines (~100px).
    """
    href = "#/2026-05-19-beyond-the-prompt/1545-agentic-ai-panel.md"
    app.goto(app.url.split("#")[0] + href)
    app.wait_for_selector("#sidebar .rl-row.active", state="attached")
    sp = app.locator("#sidebar .rl-row.active .rl-sp")
    cs = sp.evaluate(
        "el => ({chars: el.textContent.length, clamp: getComputedStyle(el).webkitLineClamp, h: el.getBoundingClientRect().height})"
    )
    assert cs["chars"] > 100, f"expected ≥100 chars of speakers, got {cs['chars']}"
    assert cs["clamp"] == "4"
    assert cs["h"] < 110, f"active row should clamp ≤4 lines, got {cs['h']}px"
