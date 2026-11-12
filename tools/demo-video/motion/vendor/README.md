# Vendored libraries

Copied unchanged from their npm packages (2026-11-12), so a render needs no install and no build. Each keeps its own
licence; none is relicensed by the repository's licence.

| Folder | Package | Files | Licence |
|---|---|---|---|
| `gsap/` | `gsap` 3.15.1 (`dist/gsap.min.js`, `dist/SplitText.min.js`) | | GSAP Standard "no charge" licence: free, including commercial use, all plugins included; the one exclusion is building a competing visual animation tool. https://gsap.com/standard-license |
| `maplibre/` | `maplibre-gl` 6.17.0 (`dist/maplibre-gl.mjs`, `dist/maplibre-gl-worker.mjs`, `dist/maplibre-gl.css`) | `LICENSE.txt` | BSD-3-Clause (with the bundled dependencies' notices in `LICENSE.txt`) |
| `three/` | `three` 0.187.0 (`build/three.module.js`, `build/three.core.js`; `examples/jsm/loaders/GLTFLoader.js`, `HDRLoader.js`; `examples/jsm/utils/BufferGeometryUtils.js`, `SkeletonUtils.js`) | `LICENSE` | MIT |
| `perfect-freehand/` | `perfect-freehand` 1.2.3 (`dist/esm/index.mjs`) | `LICENSE` | MIT |

To update one: `npm pack <package>@<version>`, copy the same files over, and change the version here.
Assets (models, HDRI, paper, photos, glyph data) are listed in `../../assets/LICENCES.md`.
