# Assets: sources, licences, credits

One row per asset the motion kit ships. Every asset here is free to use in a commercial video. Rows marked
**credit** must be credited on screen (in the scene and/or the end card); the end-card lines are listed at the
bottom, ready to paste. Data that is fetched live at render time (map tiles) is listed too, because it needs a
credit.

| Asset | Source | Licence | Credit line |
|---|---|---|---|
| `hdri/events_hall_interior_1k.hdr` | Poly Haven, "Events Hall Interior" by Dimitrios Savva and Jarod Guest, https://polyhaven.com/a/events_hall_interior | CC0 1.0 | none required ("Poly Haven" as a courtesy) |
| `models/plastic_monobloc_chair_01/` | Poly Haven, "Plastic Monobloc Chair 01" by Kuutti Siitonen, https://polyhaven.com/a/plastic_monobloc_chair_01 | CC0 1.0 | none required |
| `models/classic_laptop/` | Poly Haven, "Classic Laptop" by Arrangemonk, https://polyhaven.com/a/classic_laptop | CC0 1.0 | none required |
| `models/binder_notebook/` | Poly Haven, "Binder Notebook" by DaDrood, https://polyhaven.com/a/binder_notebook | CC0 1.0 | none required |
| `paper/paper001-color.jpg` | ambientCG, "Paper 001" (1K JPG, colour map), https://ambientcg.com/view?id=Paper001 | CC0 1.0 | none required |
| `photos/iet-savoy-place-shadowssettle-2020.jpg` | Wikimedia Commons, "IET Savoy Place.jpg" by Shadowssettle (2020-04-17), https://commons.wikimedia.org/wiki/File:IET_Savoy_Place.jpg (1920 px rendition) | CC BY-SA 4.0 | **credit**: "Photo: Shadowssettle, CC BY-SA 4.0" |
| `photos/iet-geograph-757175-glyn-baker.jpg` | Wikimedia Commons / Geograph, "The IET - geograph.org.uk - 757175.jpg" by Glyn Baker (2008-04-08), https://commons.wikimedia.org/wiki/File:The_IET_-_geograph.org.uk_-_757175.jpg | CC BY-SA 2.0 | **credit**: "Photo: Glyn Baker, CC BY-SA 2.0" |
| `glyphs/caveat.json` | Tegaki 1.1.0's stroke data for the Caveat font (`tegaki/fonts/caveat/glyphData.json`), https://github.com/KurtGokhan/tegaki | Tegaki: MIT (`glyphs/TEGAKI-LICENSE.txt`); Caveat: SIL OFL 1.1, Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat) | none required |
| Map tiles (fetched at render time, not stored) | OpenFreeMap vector tiles (OpenMapTiles schema) from OpenStreetMap data, https://openfreemap.org/ | OpenFreeMap: free, commercial use allowed; OpenMapTiles: BSD/CC-BY; OpenStreetMap data: ODbL | **credit**: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (map.js draws it in the corner) |
| Venue footprint in the sample storyboard | OpenStreetMap way 98479924 (Institution of Engineering and Technology) | ODbL | covered by the OpenStreetMap credit above |

Notes:

- **CC BY-SA photos** (share-alike): the credit must name the author and the licence. The share-alike term applies to
  the photo itself (a changed copy of it stays CC BY-SA); it does not relicense the video around it.
- The **Glyn Baker** photo is the one the research report found; it is 640 px wide (soft at 1080p), from 2008 (the
  next building is under scaffolding) and shows a passer-by. The **Shadowssettle** photo is the same view at
  1920 px, from 2020, with nobody in it, so the sample uses it. Either works with the `photo` scene; credit the one
  you use.
- The IET's own photographs are copyrighted: never use them.
- Poly Haven and ambientCG are CC0: no credit is required, but the end card may thank them.

## End-card credit lines

```
Map: OpenFreeMap © OpenMapTiles Data from OpenStreetMap
Photo of IET Savoy Place: Shadowssettle, CC BY-SA 4.0
3D models and HDRI: Poly Haven (CC0) · Paper: ambientCG (CC0)
Handwriting strokes: Tegaki (MIT), Caveat font (SIL OFL 1.1)
```

The code libraries the renderer vendors (GSAP, MapLibre, three.js, perfect-freehand) are listed in
`../motion/vendor/README.md`; they need no on-screen credit.
