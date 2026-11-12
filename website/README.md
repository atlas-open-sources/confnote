# confnote landing page

`index.html` is a standalone static page with no build step or external assets.
Preview from the repository root:

```sh
python3 -m http.server 8790 --directory website
```

Open `http://localhost:8790`. It can be hosted at an approved atlascodes subpath;
all assets are inline, so the page makes no root-relative routing assumptions.
No domain or deployment is configured here.

The download button intentionally remains disabled. After release approval,
replace it with an anchor to the verified archive, add the version, architecture,
minimum macOS version and checksum, and confirm the published URL actually
returns that artifact. Do not use a guessed GitHub release URL.

The day-goal form is an editable product preview; its answers stay in memory
and are never sent or saved. Actual first-run onboarding belongs to the app.
