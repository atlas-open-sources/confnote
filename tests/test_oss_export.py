"""The OSS exporter is tested with a disposable committed git repository."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "oss_export", Path(__file__).parents[1] / "scripts/oss_export.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.repo = self.base / "source"
        self.repo.mkdir()
        self.git_environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True, env=self.git_environment)
        self.write("README.md", "public committed source")
        self.write(
            "data/ai-engineer-worldsfair-2026/sessions.json",
            json.dumps(
                {"sessions": [{"title": "Public title", "description": "Raw long description"}]}
            ),
        )
        self.write("scripts/tool.sh", "#!/bin/sh\ntrue\n")
        (self.repo / "scripts/tool.sh").chmod(0o755)
        self.write("docs/internal/strategy/plan.md", "internal")
        self.write("docs/mochirouter.md", "internal")
        self.write("docs/feedback-me.md", "internal")
        self.write("private/notes/session.md", "personal")
        self.write(".env.local", "synthetic fixture only")
        self.write("packages/core-ui/static/modules/tldraw/index.js", "excluded")
        self.write("packages/core-ui/static/modules/aggrid/aggrid.js", "mit grid")
        self.write("packages/core-ui/static/modules/aggrid/vendor/LICENSE.txt", "MIT")
        self.write("packages/core-ui/static/modules/aggrid/vendor/unreviewed.js", "stray")
        self.write("licenses/vendor/AG-Grid-Community-MIT.txt", "MIT notice")
        self.write("docs/internal/archive/planning/ag-grid.md", "planning")
        self.write(
            "packages/core-ui/static/modules.config.json", '{"slots":["aggrid","chat","tldraw"]}'
        )
        (self.repo / "outside-link").symlink_to(self.base)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "add",
                "--",
                "README.md",
                "data",
                "scripts",
                "docs",
                "private",
                ".env.local",
                "packages",
                "licenses",
                "outside-link",
            ],
            check=True,
            env=self.git_environment,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
            env=self.git_environment,
        )

    def write(self, name, value):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def run_export(self, destination=None, dry_run=True):
        with contextlib.redirect_stdout(io.StringIO()):
            return MODULE.export(self.repo, destination, dry_run)

    def test_committed_only_and_denylist(self):
        self.write("README.md", "uncommitted secret text must not be copied")
        self.write("untracked.txt", "not committed")
        destination = self.base / "export"
        manifest = self.run_export(destination, False)
        readme = (destination / "README.md").read_text()
        self.assertTrue(readme.startswith("public committed source\n"))
        self.assertNotIn("uncommitted", readme)
        self.assertFalse((destination / ".git").exists())
        self.assertFalse((destination / "untracked.txt").exists())
        self.assertGreaterEqual(len(manifest["dropped"]), 7)
        self.assertEqual(
            json.loads((destination / "packages/core-ui/static/modules.config.json").read_text())[
                "slots"
            ],
            ["aggrid", "chat"],
        )
        self.assertEqual(
            (destination / "packages/core-ui/static/modules/aggrid/aggrid.js").read_text(),
            "mit grid",
        )
        self.assertTrue((destination / "licenses/vendor/AG-Grid-Community-MIT.txt").exists())
        grid_vendor = destination / "packages/core-ui/static/modules/aggrid/vendor"
        self.assertTrue((grid_vendor / "LICENSE.txt").exists())
        self.assertFalse((grid_vendor / "unreviewed.js").exists())
        self.assertFalse((destination / "docs/internal/archive/planning/ag-grid.md").exists())
        self.assertFalse((destination / "docs/internal/strategy/plan.md").exists())
        self.assertFalse((destination / "packages/core-ui/static/modules/tldraw").exists())
        self.assertTrue((destination / "scripts/tool.sh").stat().st_mode & 0o100)
        self.assertFalse((destination / "outside-link").exists())
        schedule = json.loads(
            (destination / "data/ai-engineer-worldsfair-2026/sessions.json").read_text()
        )
        self.assertEqual(schedule["sessions"], [{"title": "Public title"}])
        public_manifest = json.loads((destination / "OSS-EXPORT-MANIFEST.json").read_text())
        self.assertNotIn("dropped", public_manifest)

    def test_bryntum_module_code_ships_without_bryntum_bundle_or_key(self):
        module = "packages/core-ui/static/modules/bryntum"
        self.write(f"{module}/bryntum.js", "our module")
        self.write(f"{module}/build/src/island.js", "our entry")
        self.write(f"{module}/license.local.js.example", "placeholder")
        self.write(f"{module}/license.local.js", "synthetic fixture only")
        self.write(f"{module}/vendor/bryntum-island.bundle.js", "licensed")
        self.write(f"{module}/vendor/fa-solid-900.woff2", "licensed")
        self.write(f"{module}/build/node_modules/@bryntum/core/index.js", "licensed")
        self.write("packages/core-ui/static/modules.config.json", '{"slots":["bryntum","chat"]}')
        for args in (["add", "-f", "--", "packages"], ["commit", "-qm", "bryntum"]):
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.repo),
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    *args,
                ],
                check=True,
                env=self.git_environment,
            )
        destination = self.base / "export"
        self.run_export(destination, False)
        shipped = destination / module
        self.assertEqual((shipped / "bryntum.js").read_text(), "our module")
        self.assertTrue((shipped / "build/src/island.js").exists())
        self.assertTrue((shipped / "license.local.js.example").exists())
        self.assertFalse((shipped / "license.local.js").exists())
        self.assertFalse((shipped / "vendor").exists())
        self.assertFalse((shipped / "build/node_modules").exists())
        self.assertIn("Sponsor modules in this export", (destination / "README.md").read_text())
        slots = json.loads(
            (destination / "packages/core-ui/static/modules.config.json").read_text()
        )["slots"]
        self.assertIn("bryntum", slots, "npm install builds the bundle, so the slot stays on")

    def test_dry_run_creates_nothing_and_existing_target_is_refused(self):
        destination = self.base / "export"
        self.run_export(destination)
        self.assertFalse(destination.exists())
        destination.mkdir()
        with self.assertRaisesRegex(ValueError, "must not exist"):
            self.run_export(destination, False)

    def test_symlink_parent_and_source_destination_are_refused(self):
        link = self.base / "link"
        link.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.run_export(link / "new", False)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.run_export(self.repo / "export", False)
        middle = self.base / "middle"
        middle.mkdir()
        with self.assertRaisesRegex(ValueError, "outside"):
            self.run_export(middle / ".." / "source" / "export", False)
        self.assertEqual(MODULE.drop_reason("bad\npath"), "unsafe path")
        self.assertEqual(MODULE.drop_reason("../escape"), "unsafe path")
        self.assertIsNotNone(MODULE.drop_reason("secret.pem"))
        self.assertIsNone(MODULE.drop_reason("packages/auth/src/index.ts"))
        self.assertIsNone(MODULE.drop_reason("tests/test_private.py"))


if __name__ == "__main__":
    unittest.main()
