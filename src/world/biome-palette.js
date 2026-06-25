/* ------------------------------------------------------------------ *
 *  Inversia — biome classes + their land-cover palette (shared contract)
 *
 *  The worker (src/world/gen/biome.js) classifies each land cell into one of these
 *  ids and tags the traced polygons with `properties.biome`; the map's biome-fill
 *  layer (src/world.js) paints each id with the matching colour. Both sides import
 *  from here so the ids and tints can't drift. Kept dependency-free so the main
 *  bundle can read the palette without pulling in the worker's geometry libs.
 * ------------------------------------------------------------------ */

// Biome class ids (0..7); 255 marks non-land.
export const BIOME = {
  ICE: 0,
  TUNDRA: 1,
  TAIGA: 2,
  STEPPE: 3,
  TEMPERATE_FOREST: 4,
  DESERT: 5,
  SAVANNA: 6,
  TROPICAL_FOREST: 7,
  NONE: 255,
};

// id → fill colour, in class order. Drives the biome-fill layer's `match` paint.
export const BIOME_PALETTE = [
  [BIOME.ICE, "#eef2f5"],
  [BIOME.TUNDRA, "#cdd3c6"],
  [BIOME.TAIGA, "#9fb389"],
  [BIOME.STEPPE, "#d8cf9c"],
  [BIOME.TEMPERATE_FOREST, "#8fb074"],
  [BIOME.DESERT, "#e6d6ab"],
  [BIOME.SAVANNA, "#cfc684"],
  [BIOME.TROPICAL_FOREST, "#6ba368"],
];
