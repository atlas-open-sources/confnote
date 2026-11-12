"""Sidebar drag-resize: grip handler updates --sidebar-w, clamps to bounds,
persists to localStorage, restores on reload."""

from __future__ import annotations

_DRAG_GRIP_JS = r"""
(targetX) => {
  const grip = document.querySelector('.sb-grip');
  const r = grip.getBoundingClientRect();
  const y = r.top + r.height / 2;
  grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: r.x + 3, clientY: y }));
  grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
  grip.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, pointerId: 1, clientX: targetX, clientY: y }));
  return {
    width: parseInt(getComputedStyle(document.getElementById('sidebar')).width, 10),
    cssVar: document.documentElement.style.getPropertyValue('--sidebar-w'),
    saved: localStorage.getItem('confnote-sidebar-w'),
    bodyResizingFlagCleared: !document.body.classList.contains('sb-resizing'),
  };
}
"""


def test_grip_resizes_sidebar(app):
    result = app.evaluate(_DRAG_GRIP_JS, 420)
    assert result["width"] == 420
    assert result["cssVar"] == "420px"
    assert result["saved"] == "420"
    assert result["bodyResizingFlagCleared"]


def test_grip_clamps_to_minimum(app):
    """Min is 200px — dragging hard left shouldn't crush the sidebar."""
    result = app.evaluate(_DRAG_GRIP_JS, 50)
    assert result["width"] == 200


def test_grip_clamps_to_maximum(app):
    """Max is 520px — dragging past the limit should clamp."""
    result = app.evaluate(_DRAG_GRIP_JS, 1200)
    assert result["width"] == 520


def test_width_persists_across_reload(app, confnote_server):
    app.evaluate(_DRAG_GRIP_JS, 360)
    app.reload()
    app.wait_for_selector("#sidebar .sb-conf")
    width = app.evaluate(
        "() => parseInt(getComputedStyle(document.getElementById('sidebar')).width, 10)",
    )
    assert width == 360
