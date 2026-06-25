# Bundled glyphs

MapLibre renders `text-field` labels from font **glyph PBFs** served at
`glyphs: <base>/fonts/{fontstack}/{range}.pbf` (see `baseStyle()` in
`src/world.js`). We self-host them so the app — and any baked world — stays
self-contained and works offline; no external glyph server at runtime.

Only the `0-255` range is shipped (Basic Latin + Latin-1): the procedural place
names (`src/world/names.js`) are ASCII, so that single range covers every glyph.

- **Font:** Open Sans (Regular / Semibold / Italic)
- **License:** Apache License 2.0 — https://fonts.google.com/specimen/Open+Sans/about
- **Source of the prebuilt PBFs:** https://fonts.openmaptiles.org

To add coverage for non-ASCII names later, fetch the matching higher ranges
(e.g. `256-511.pbf`) into the same per-fontstack folders.
