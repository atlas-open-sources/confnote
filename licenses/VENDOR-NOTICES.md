# Third-party notices

| Asset | Identity and provenance | License notice |
|---|---|---|
| `packages/core-ui/static/vendor/easymde.min.js` and `.css` | EasyMDE 2.21.0, version stated in the shipped header; Jeroen Akkerman and contributors | [MIT](vendor/EasyMDE-MIT.txt), upstream https://github.com/Ionaru/easy-markdown-editor |
| `packages/core-ui/static/vendor/deep-chat.bundle.js` | Deep Chat, Ovidijus Parsiunas and contributors; existing bundled version is not recorded in the source, SHA-256 `4be8e65b12c0678ccc06fd157a402be4dc7c01f910056166518781f1de2d6ad7` | [MIT](vendor/deep-chat-MIT.txt), upstream https://github.com/OvidijusParsiunas/deep-chat |
| `packages/core-ui/static/modules/aggrid/vendor/ag-grid-community.min.js` | AG Grid Community 36.3.0, unmodified npm `dist` file; AG GRID LTD; SHA-256 `5fc8736cc0726dcd2e2901681180462fe4d1a519b31a2b4ab7268a97a52a3532` | [MIT](vendor/AG-Grid-Community-MIT.txt), upstream https://github.com/ag-grid/ag-grid |
| `packages/core-ui/static/modules/aggrid/vendor/ag-charts-community.min.js` | AG Charts Community 14.3.0, unmodified npm `dist/umd` file; AG GRID LTD; SHA-256 `bb55974410690aa28266f4512dd6091f9ae882f810e16287f8da5f2ad7223277` | [MIT](vendor/AG-Charts-Community-MIT.txt), upstream https://github.com/ag-grid/ag-charts |
| confs.tech source facts | tech-conferences/conference-data contributors | Existing `packages/enrichment/confs-tech-LICENSE` and published data notice |
| `tools/demo-video/motion/vendor/` (demo-video renderer only, not shipped in the app) | GSAP 3.15.1, MapLibre GL JS 6.17.0, three.js 0.187.0, perfect-freehand 1.2.3: unmodified npm files, listed in that folder's `README.md` | GSAP Standard no-charge licence (https://gsap.com/standard-license); MapLibre [BSD-3-Clause](../tools/demo-video/motion/vendor/maplibre/LICENSE.txt); three.js [MIT](../tools/demo-video/motion/vendor/three/LICENSE); perfect-freehand [MIT](../tools/demo-video/motion/vendor/perfect-freehand/LICENSE) |
| `tools/demo-video/assets/` (demo-video media only) | Poly Haven and ambientCG CC0 assets, two CC BY-SA photos of IET Savoy Place, Tegaki's Caveat stroke data | One row per asset with its credit line in [`tools/demo-video/assets/LICENCES.md`](../tools/demo-video/assets/LICENCES.md) |

The Deep Chat notice was obtained from its 2.5.1 npm source package; that is a
notice source, **not a claim that the pre-existing bundle is version 2.5.1**.
Before a public release, recover or reproducibly rebuild the exact original
vendor artifact and retain its transitive license notices. The exporter is a
local preparation tool, not an assertion of release readiness.

EasyMDE includes CodeMirror and other dependencies. Preserve embedded copyright
headers and retain the upstream distribution licenses when rebuilding it.
Python and npm dependencies installed from lockfiles retain their own licenses;
packaging must retain their bundled metadata/notices. This inventory does not
relicense dependency code or claim all transitive notices have been audited.

Excluded from OSS artifacts: `modules/tldraw`, its backend and bundled code,
Bryntum, any AG Grid Enterprise code (none exists here), and development-only
vendor build directories. The AG Grid **Community** Grids module (`modules/aggrid`) ships.
