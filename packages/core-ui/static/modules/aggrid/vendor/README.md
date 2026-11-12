# Vendored AG Grid Community

- Package: `ag-grid-community@36.3.0` (npm), licence MIT (`LICENSE.txt`, also
  `licenses/vendor/AG-Grid-Community-MIT.txt`).
- Tarball integrity: `sha512-0JRaIwE82TuOcx+upA3OnTyhDAIUDqrMxLoBib6yVON0SyfICdpOnwD4QdiT0A1lgrC8SkzLBFRst73bTREF6Q==`
- File: `dist/ag-grid-community.min.js` copied unmodified, SHA-256
  `5fc8736cc0726dcd2e2901681180462fe4d1a519b31a2b4ab7268a97a52a3532`.
- Community only. Never add `ag-grid-enterprise` or any enterprise module: it
  needs a commercial licence key and watermarks the grid.

Upgrade: download the new tarball, check its `dist.integrity`, replace both
files, update the hashes above.

# Vendored AG Charts Community

- Package: `ag-charts-community@14.3.0` (npm), licence MIT (`LICENSE-ag-charts.txt`, also
  `licenses/vendor/AG-Charts-Community-MIT.txt`).
- Tarball integrity: `sha512-rrvL9hSEFOJ9Y3vKrChlekX4c4wV/zevNGdtufuSIgyDAEh6v8SVRz9DuUdZKhjo8xEXGEfdhbUNmjMHzyYFMQ==`
- File: `dist/umd/ag-charts-community.min.js` copied unmodified (self-contained UMD, global `agCharts`), SHA-256 below
  and in `tests/test_aggrid_module.py`: `bb55974410690aa28266f4512dd6091f9ae882f810e16287f8da5f2ad7223277`.
- Community only. Never add `ag-charts-enterprise`: it needs a commercial licence key and watermarks the chart.
- Loaded only when the Ledger view opens (the balance chart above the grid).
