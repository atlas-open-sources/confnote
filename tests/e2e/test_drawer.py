"""Drawer primitive + chat-as-a-module e2e.

Covers:
- the drawer ready promise is published.
- right-edge handle(s) render based on modules.config.json.
- chat module suppresses the legacy bottom-right ✦ FAB (no flash, no
  double surface).
- clicking a handle opens the drawer + activates its tab.
- × closes the drawer.
- the strip shifts left by --drawer-w when the drawer is open.
- the grip resizes the drawer + persists width.
- the disposability grep test: no module names appear in core app.js.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


# ----------------------------------------------------------------- boot ----


def _open_session(page):
    """Navigate to a real session so the chat module has a scope."""
    page.evaluate(
        "() => { location.hash = '#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md'; }"
    )
    page.wait_for_selector("#drawerStrip")


def test_drawer_ready_promise_exposed(app):
    """drawer.ready must be a real Promise so app.js's refreshConcierge can
    await it before deciding whether to build the legacy FAB."""
    _open_session(app)
    has_ready = app.evaluate("() => typeof window.confnote?.drawer?.ready?.then === 'function'")
    assert has_ready


def test_chat_handle_renders_and_fab_is_suppressed(app):
    """The chat module is in modules.config.json by default → its handle
    appears on the right edge AND the legacy bottom-right FAB is gone."""
    _open_session(app)
    # give the drawer bootstrap one frame to finish
    app.wait_for_function(
        "() => document.querySelector('.drawer-tab[data-id=\"chat\"]') !== null",
        timeout=3000,
    )
    state = app.evaluate(
        """() => ({
            tabIds: [...document.querySelectorAll('.drawer-tab')].map(t => t.dataset.id),
            fabSuppressed: window.confnote?.fab?.suppressed === true,
            fabHidden: !document.getElementById('conciergeFab')
                || document.getElementById('conciergeFab').style.display === 'none',
        })"""
    )
    assert "chat" in state["tabIds"]
    assert state["fabSuppressed"]
    assert state["fabHidden"], "the legacy bottom-right FAB must be hidden when chat is in slots"


def test_clicking_chat_handle_opens_drawer_with_deep_chat(app):
    _open_session(app)
    app.wait_for_selector(".drawer-tab[data-id='chat']")
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function(
        "() => document.getElementById('drawerHost')?.classList.contains('open')",
        timeout=2000,
    )
    app.wait_for_selector("#drawerBody deep-chat", timeout=3000)
    out = app.evaluate(
        """() => ({
            open: document.getElementById('drawerHost')?.classList.contains('open'),
            title: document.getElementById('drawerTitle')?.textContent,
            hasDeepChat: !!document.querySelector('#drawerBody deep-chat'),
            activeId: document.querySelector('.drawer-tab.on')?.dataset.id,
        })"""
    )
    assert out["open"]
    # the chat module labels itself "Concierge" in its register() call;
    # see packages/core-ui/static/modules/chat/chat.js
    assert out["title"] == "Concierge"
    assert out["hasDeepChat"], (
        "the concierge deep-chat element should be mounted in the drawer body"
    )
    assert out["activeId"] == "chat"


def test_close_button_hides_drawer(app):
    _open_session(app)
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function("() => document.getElementById('drawerHost')?.classList.contains('open')")
    app.locator("#drawerClose").click()
    app.wait_for_function(
        "() => !document.getElementById('drawerHost')?.classList.contains('open')"
    )
    assert app.locator(".drawer-tab.on").count() == 0


def test_shift_click_opens_second_panel_without_remounting_first(app):
    """Shift-clicking a second handle opens it ALONGSIDE the first (e.g.
    Concierge + tldraw, to watch it draw). The first panel must not be
    re-rendered — we tag its body and assert the tag survives."""
    _open_session(app)
    app.wait_for_selector(".drawer-tab[data-id='chat']")
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function("() => document.getElementById('drawerHost')?.classList.contains('open')")
    # tag the first (primary) panel body — a remount would wipe this
    app.evaluate("() => { document.getElementById('drawerBody').dataset.probe = 'keep'; }")

    # Slot 1 in the default config (both placeholder slots now hold real modules).
    app.locator(".drawer-tab[data-id='aggrid']").click(modifiers=["Shift"])
    app.wait_for_function(
        "() => document.querySelectorAll('.drawer-host.open').length === 2", timeout=2000
    )
    # both handles active, and the first panel was NOT remounted
    assert app.locator(".drawer-tab.on").count() == 2
    assert app.evaluate("() => document.getElementById('drawerBody').dataset.probe") == "keep"

    # a plain (non-shift) click collapses back to a single panel
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function(
        "() => document.querySelectorAll('.drawer-host.open').length === 1", timeout=2000
    )
    assert app.locator(".drawer-tab.on").count() == 1


def test_strip_shifts_left_when_drawer_open(app):
    """When drawer is open, the handle strip should sit at the drawer's left
    edge (right: var(--drawer-w)) so the user can switch slots.

    The strip has a 0.25s `right` transition; we have to wait for the
    transition to land, not just for body.drawer-open to be applied.
    """
    _open_session(app)
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function(
        "() => document.body.classList.contains('drawer-open')"
        " && document.getElementById('drawerHost')?.classList.contains('open')",
        timeout=2000,
    )
    # Wait until the strip's computed `right` matches the drawer width to
    # within 1px — i.e. the transition has finished and the rule is applied.
    app.wait_for_function(
        """() => {
          const strip = document.getElementById('drawerStrip');
          const host = document.getElementById('drawerHost');
          if (!strip || !host) return false;
          const stripRight = parseFloat(getComputedStyle(strip).right);
          const hostWidth = parseFloat(getComputedStyle(host).width);
          return Math.abs(stripRight - hostWidth) < 2;
        }""",
        timeout=2000,
    )
    out = app.evaluate(
        """() => ({
          stripRight: parseFloat(getComputedStyle(document.getElementById('drawerStrip')).right),
          hostWidth: parseFloat(getComputedStyle(document.getElementById('drawerHost')).width),
        })"""
    )
    assert out["hostWidth"] >= 300  # MIN_W
    assert abs(out["stripRight"] - out["hostWidth"]) < 2, (
        f"strip's right should match drawer width — got strip={out['stripRight']}px, host={out['hostWidth']}px"
    )


def test_open_drawer_reserves_width_only_when_the_column_has_room(app):
    """At 1440 the open drawer reserves its width so the column stays clear of it; below 1200 it
    overlays instead, because reserving 480px left the column about 200px wide."""
    _open_session(app)
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function("() => document.body.classList.contains('drawer-open')", timeout=2000)
    padding = "() => parseFloat(getComputedStyle(document.getElementById('app')).paddingRight)"
    app.set_viewport_size({"width": 1440, "height": 900})
    app.wait_for_function(f"() => ({padding})() > 300", timeout=2000)
    app.set_viewport_size({"width": 1024, "height": 900})
    app.wait_for_function(f"() => ({padding})() === 0", timeout=2000)


def test_grip_drag_resizes_and_persists(app, confnote_server):
    _open_session(app)
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function("() => document.getElementById('drawerHost')?.classList.contains('open')")
    # synthesise a pointer drag of the grip — target width 600px
    result = app.evaluate(
        r"""
        (targetW) => {
          const grip = document.getElementById('drawerGrip');
          const r = grip.getBoundingClientRect();
          const y = r.top + r.height / 2;
          // clientX maps to (window.innerWidth - clientX) = new width;
          // so to get width = targetW we need clientX = innerWidth - targetW
          const targetX = window.innerWidth - targetW;
          grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: r.x + 3, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          return {
            width: parseInt(getComputedStyle(document.getElementById('drawerHost')).width, 10),
            saved: localStorage.getItem('confnote-drawer-w'),
          };
        }
        """,
        600,
    )
    assert result["width"] == 600
    assert result["saved"] == "600"


def test_grip_drag_clamps_to_bounds(app):
    _open_session(app)
    app.locator(".drawer-tab[data-id='chat']").click()
    app.wait_for_function("() => document.getElementById('drawerHost')?.classList.contains('open')")
    # below MIN_W=300
    w_min = app.evaluate(
        r"""
        () => {
          const grip = document.getElementById('drawerGrip');
          const r = grip.getBoundingClientRect();
          const y = r.top + r.height / 2;
          const targetX = window.innerWidth - 50;  // requested width 50, must clamp to 300
          grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: r.x + 3, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          return parseInt(getComputedStyle(document.getElementById('drawerHost')).width, 10);
        }
        """
    )
    assert w_min == 300
    # above MAX_W=900
    w_max = app.evaluate(
        r"""
        () => {
          const grip = document.getElementById('drawerGrip');
          const r = grip.getBoundingClientRect();
          const y = r.top + r.height / 2;
          const targetX = -500;  // way left of viewport → very wide, must clamp to 900
          grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: r.x + 3, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          grip.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
          return parseInt(getComputedStyle(document.getElementById('drawerHost')).width, 10);
        }
        """
    )
    assert w_max == 900


def test_max_slots_is_four(app):
    _open_session(app)
    cap = app.evaluate("() => window.confnote.drawer.MAX_SLOTS")
    assert cap == 4


# ------------------------------------------------- disposability boundary --


def test_disposability_grep_no_module_names_in_core_app_js():
    """The hard rule from CLAUDE.md + AGENTS.md: core app.js never knows the
    names of vendor / placeholder modules. The drawer primitive is generic;
    modules self-register. Enforce with a grep test.
    """
    core_app_js = (REPO / "packages/core-ui/static/app.js").read_text()
    # Include the spaced "ag grid" form — "aggrid" alone misses "AG Grid".
    forbidden = ["aggrid", "ag grid", "bryntum", "tldraw", "module-1", "module-2"]
    found = [name for name in forbidden if name.lower() in core_app_js.lower()]
    assert not found, f"core app.js mentions module names (boundary violation): {found}"
