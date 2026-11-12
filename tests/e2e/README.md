# confnote — Playwright e2e tests

End-to-end browser tests for the UI behaviours that unit tests can't reach:
sidebar layout, drag-to-split panes, drag-to-resize sidebar, speaker-text
clamping. Each test session spins up its own confnote server pointed at a
tmp vault seeded from `seed-agenda.json` (a verbatim copy of the Beyond The
Prompt agenda), so the user's real `~/Documents/confnote/` is never touched.

## First-time setup

```
make e2e-install      # pip install pytest-playwright + browser binaries
```

## Run

```
make e2e              # runs the full suite (headed=false by default)
make e2e HEADED=1     # open a visible Chromium window — useful when adding
                      # new tests
```

## Suite layout

- `conftest.py`         — session-scoped server fixture + per-test `app` page.
- `test_layout.py`      — sidebar is persistent + same width across home /
                          conference / session views (no layout jolt).
- `test_split_pane.py`  — drag a tab to the right of `.panes` opens pane 2,
                          drop on left changes pane 1, × closes the split,
                          repeated drag swaps pane 2's section.
- `test_sidebar_resize.py` — grip drag updates `--sidebar-w`, clamps to
                          `[200, 520]px`, persists to localStorage,
                          restores on reload.
- `test_speaker_clamp.py` — `.rl-sp` line-clamps to 2 lines (idle) / 4 lines
                          (active) so a 4-speaker panel doesn't bloat the
                          whole sidebar.

## DnD note

Playwright's `locator.drag_to()` synthesises mouse events, which Chromium
does **not** translate to HTML5 drag events (`dragstart` / `dragover` /
`drop`). Our split listener uses HTML5 drag, so the tests dispatch those
events directly via `page.evaluate()`. This exercises every line of the
drop handler; the OS-level drag itself was verified manually before this
suite was written.
