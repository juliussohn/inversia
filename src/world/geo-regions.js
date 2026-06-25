/* ------------------------------------------------------------------ *
 *  Inversia — real-world geographic reference (Phase 12)
 *
 *  The world is INVERTED: today's continents drown into water basins and today's
 *  oceans rise as the new land. This module pins a handful of REAL-WORLD anchors
 *  to that geography so the atlas reads as a recognisable mirror of Earth:
 *
 *    CONTINENTS  — each of today's continents, with the adjective we name its
 *      drowned basin after ("African Ocean") and a representative lon/lat at the
 *      continent's footprint. In the inverted world that footprint is now water,
 *      so dropping a label there names the new sea after the land it replaced —
 *      and places it exactly where that land sits today.
 *
 *    FAMILY_ANCHORS — cultural centres pinned to where the real language families
 *      live, keyed by the phonotactic family in names.js. Each country takes its
 *      NEAREST anchor's family, so an "Asian-sounding" name falls near where Asia
 *      is today, a Nordic one near Scandinavia, and so on — geography drives the
 *      phonetic feel instead of a per-seed shuffle.
 *
 *  COORDINATES match the rest of the pipeline: plain lon/lat, x wraps at ±180°.
 *  Distances are taken on the unit sphere (see names.js) so they respect the
 *  antimeridian and the poles.
 * ------------------------------------------------------------------ */

// Today's continents → the name of the ocean they become, anchored at the
// continent's rough centroid (lon, lat). Eurasia is split into Europe + Asia so
// the one connected Afro-Eurasian basin still reads with three regional seas
// (African / European / Asian) right where each region sits.
export const CONTINENTS = [
  { key: "africa", adj: "African", lon: 20, lat: 3 },
  { key: "europe", adj: "European", lon: 18, lat: 52 },
  { key: "asia", adj: "Asian", lon: 92, lat: 46 },
  { key: "north-america", adj: "North American", lon: -100, lat: 44 },
  { key: "south-america", adj: "South American", lon: -60, lat: -14 },
  { key: "australia", adj: "Australian", lon: 134, lat: -25 },
  { key: "antarctica", adj: "Antarctic", lon: 20, lat: -78 },
];

// The mirror of CONTINENTS: today's oceans rise into the new land. A label at an
// ocean's centre names the continent it becomes and drops it right where that
// ocean lies today — but only where the spot is actually land now (a normal world
// has water here, so it's skipped). The two giants are split N/S so their vast new
// continents read at both ends instead of carrying one lonely name in the middle.
export const NEW_CONTINENTS = [
  { key: "n-pacific", name: "North Pacifica", lon: -150, lat: 32 },
  { key: "s-pacific", name: "South Pacifica", lon: -120, lat: -30 },
  { key: "n-atlantic", name: "North Atlantica", lon: -40, lat: 36 },
  { key: "s-atlantic", name: "South Atlantica", lon: -18, lat: -28 },
  { key: "indian", name: "Indica", lon: 78, lat: -22 },
  { key: "arctic", name: "Arctica", lon: 0, lat: 84 },
];

// Language-family anchors at the real cultural homelands. `fam` is the family key
// from names.js's FAMILIES table. Several families carry more than one anchor so
// the nearest-anchor assignment covers the whole globe without bald patches.
export const FAMILY_ANCHORS = [
  { fam: "verdane", lon: 8, lat: 42 },    // Romance — Mediterranean
  { fam: "verdane", lon: -62, lat: -12 }, // Romance — Latin America
  { fam: "fjordic", lon: 12, lat: 62 },   // Nordic — Scandinavia
  { fam: "vossk", lon: 42, lat: 55 },     // Slavic — Eastern Europe / Russia
  { fam: "qaram", lon: 44, lat: 26 },     // Semitic / arid — Arabia
  { fam: "qaram", lon: 12, lat: 20 },     // Semitic / arid — Sahara / Sahel
  { fam: "shenlu", lon: 112, lat: 34 },   // East-Asian — East Asia
  { fam: "shenlu", lon: 108, lat: 14 },   // East-Asian — South-East Asia
  { fam: "manako", lon: -150, lat: -8 },  // Oceanic — central Pacific
  { fam: "manako", lon: 165, lat: -10 },  // Oceanic — Melanesia
];
