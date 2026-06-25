/* ------------------------------------------------------------------ *
 *  Inversia — biome / land-cover zones (vector)
 *
 *  The "Natural" style colours land by LAND COVER — vegetation green, desert tan,
 *  ice white — the way Apple/Google base maps do. Rather than shade it per-pixel
 *  (which inherits the relief's bumpy texture and reads soft), we build CRISP
 *  VECTOR ZONES here: classify every land cell into a biome, then trace each
 *  biome's regions into filled polygons the map draws as flat tints over a faint
 *  hillshade. Resolution-independent, clean edges — the atlas look.
 *
 *  Climate has two axes:
 *    • TEMPERATURE — from latitude (warm equator → cold poles) minus an elevation
 *      lapse (so high terrain runs cold and snow-caps). The lapse is gentle on
 *      purpose: Inversia's risen sea-floor continents are kilometres tall, and a
 *      steep lapse would freeze the whole world white.
 *    • MOISTURE — the harder axis, because it depends on the whole world: how far a
 *      cell sits from the sea, and whether a range upwind has wrung the rain out.
 *      Three multiplied factors:
 *        1. latitude bands — the circulation: wet equatorial belt (ITCZ), dry
 *           subtropics (~±25–35°, Earth's desert latitudes), moist mid-latitudes
 *           (~50°), drying again toward the poles.
 *        2. continentality — moisture falls off with distance from the sea.
 *        3. orographic rain-shadow — air climbing a range upwind drops its rain on
 *           the windward slope, leaving the lee dry. Winds flip with the cells
 *           (tropical easterlies vs. mid-latitude westerlies).
 *
 *  Temperature × moisture pick a biome on a Whittaker-style square. The zones are
 *  then polygonised per class with the shared marching-squares contourer (the same
 *  one the coastline uses): each class's cell mask is contoured at 0.5 and the
 *  rings XOR-assembled into a MultiPolygon-with-holes, exactly like the land fill —
 *  so adjacent classes tile with no gaps and enclosed patches punch clean holes.
 *
 *  Inversion note: like every pass, this flips the elevation sign first so the
 *  climate is computed for the world as displayed (risen oceans, drowned land).
 * ------------------------------------------------------------------ */

import polygonClipping from "polygon-clipping";
import { marchingSquares } from "./coast.js";
import { BIOME } from "../biome-palette.js";
import { clamp01, bfsDistance } from "./grid.js";

// The land classes we polygonise: every id except NONE (which marks non-land).
const CLASS_IDS = Object.values(BIOME).filter((id) => id !== BIOME.NONE);

/**
 * Classify + polygonise the world into biome zones.
 * @param {{elev: Float32Array, W: number, H: number}} field
 * @param {{W:number,H:number,recv:Int32Array,acc:Float64Array}} flow  hydrology pass
 * @param {{water: number, invert: boolean}} opts
 * @returns {{biomes: object}}  FeatureCollection of MultiPolygons, one per class
 */
export function computeBiomes(field, flow, opts) {
  const { W, H } = field;
  const clim = resolveClimate(opts);
  const { moisture, above, isLand } = climateFields(field, flow, opts, clim);
  const biome = classify(moisture, above, isLand, W, H, clim);
  return { biomes: polygonize(biome, W, H) };
}

// Map the panel's normalised 0..1 climate knobs onto the moisture model's actual
// constants. Each is centred so 0.5 reproduces the hand-tuned baseline; missing
// values (old worlds / no Natural style) fall back to 0.5, i.e. that baseline.
function resolveClimate(opts) {
  const k = (v) => (Number.isFinite(v) ? v : 0.5);
  const continental = k(opts.continental);
  const maritimeReach = k(opts.maritimeReach);
  const coastalHumidity = k(opts.coastalHumidity);
  const riverGreening = k(opts.riverGreening);
  const rainShadow = k(opts.rainShadow);
  const altitudeCooling = k(opts.altitudeCooling);
  const rainfall = k(opts.rainfall);
  const tropicalExtent = k(opts.tropicalExtent);
  const temperateRain = k(opts.temperateRain);
  const riverWidth = k(opts.riverWidth);
  const vegetation = k(opts.vegetation);
  return {
    contFloor: 0.65 - 0.6 * continental,        // 0.5 → 0.35  (interior dryness floor)
    contScaleFrac: 0.02 + 0.06 * maritimeReach, // 0.5 → 0.05  (× W; continentality reach)
    wSea: 0.8 * coastalHumidity,                // 0.5 → 0.40  (near-shore humid lift)
    wRiver: riverGreening,                       // 0.5 → 0.50  (riparian lift)
    leeDecay: 6000 * Math.pow(0.1, rainShadow),  // 0.5 → ~1900 (m; smaller = stronger shadow)
    lapse: 4000 + (1 - altitudeCooling) * 9000,  // 0.5 → 8500  (m; smaller = more snow)
    rainfallMul: 0.4 + 1.2 * rainfall,           // 0.5 → 1.0   (global wetness multiplier)
    eqSigma: 4 + 16 * tropicalExtent,            // 0.5 → 12    (° width of the equatorial wet belt)
    midlatCoef: temperateRain,                   // 0.5 → 0.5   (mid-latitude storm-belt rainfall)
    riverScale: 1 + 5 * riverWidth,              // 0.5 → 3.5   (cells; river valley half-width)
    vegShift: (0.5 - vegetation) * 0.3,          // 0.5 → 0     (− = more forest, + = more grass/desert)
  };
}

// ---- climate fields -------------------------------------------------------

// Discharge (km² drained) above which a cell counts as a river for humidity. Fixed
// — NOT the recipe's display threshold — so the climate is stable when the user
// only thins the drawn river network. Picks out real channels, tributaries up.
const RIVER_HUMID_KM2 = 15000;

// Per-cell moisture (0..1), height above sea (m) and a land mask, in one pass.
//
// Moisture is a SYNOPTIC field (the large-scale circulation, dried in rain-shadows)
// LIFTED toward wet by nearby water. The lift is additive, not multiplicative, so
// proximity to the sea, a lake or a river raises humidity even at a dry latitude —
// that's what keeps coasts, islands, lake shores and river valleys (the Nile case)
// out of the desert classes while leaving deep continental interiors arid.
function climateFields(field, flow, opts, clim) {
  const { elev, W, H } = field;
  const N = W * H;
  const sea = opts.water;
  const sign = opts.invert ? -1 : 1;

  const above = new Float32Array(N);
  const isLand = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const a = sign * elev[i] - sea;
    above[i] = a;
    isLand[i] = a > 0 ? 1 : 0;
  }

  // Distance (in cells) to the two kinds of water that humidify the land:
  //   • open water — ocean AND enclosed lakes (every non-land cell): broad maritime reach
  //   • rivers — land cells whose discharge clears RIVER_HUMID_KM2: a narrow green ribbon
  const distSea = bfsDistance(N, W, H, (i) => !isLand[i], () => true);
  const acc = flow?.acc;
  const distRiver = bfsDistance(N, W, H, (i) => isLand[i] && acc && acc[i] >= RIVER_HUMID_KM2, () => true);

  // Reach of each effect, in cells. CONT_SCALE: how far maritime air penetrates
  // before the interior dries out (continentality — what carves the great interior
  // deserts). MARITIME_SCALE: a tighter near-shore humid lift so coasts, islands and
  // lake shores never read as desert. RIVER_SCALE: a river only wets its own valley.
  const CONT_SCALE = W * clim.contScaleFrac;
  const MARITIME_SCALE = W * 0.02;
  const RIVER_SCALE = clim.riverScale;
  const CONT_FLOOR = clim.contFloor; // how dry the deepest interior gets (× synoptic)
  const W_SEA = clim.wSea;            // near-shore humid lift
  const W_RIVER = clim.wRiver;        // riparian lift, where climate allows it

  const SHADOW_R = Math.max(4, Math.round(W / 120));
  const LEE_DECAY = clim.leeDecay; // metres of upwind barrier that halves the lee moisture

  const moisture = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    const absLat = Math.abs(lat);
    const band = latitudeBand(lat, clim);
    const windX = absLat > 35 ? 1 : -1; // air travels: easterlies in tropics, westerlies mid-lat
    const row = y * W;

    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!isLand[i]) continue;

      // synoptic: circulation band, dried where a range stands upwind (rain-shadow)
      let barrier = 0;
      for (let k = 1; k <= SHADOW_R; k++) {
        const xx = ((x - windX * k) % W + W) % W;
        const hb = sign * elev[row + xx] - sea;
        if (hb > barrier) barrier = hb;
      }
      const rise = barrier - (above[i] > 0 ? above[i] : 0);
      const lee = rise > 0 ? Math.exp(-rise / LEE_DECAY) : 1;
      const synoptic = band * lee;

      // continentality: full synoptic at the coast, drying to CONT_FLOOR deep
      // inland — this is what restores the big interior deserts.
      const seaReach = Math.exp(-distSea[i] / CONT_SCALE);
      const base = synoptic * (CONT_FLOOR + (1 - CONT_FLOOR) * seaReach);

      // near-shore maritime lift (keeps coasts / islands / lake shores off desert)
      const maritime = W_SEA * Math.exp(-distSea[i] / MARITIME_SCALE);

      // riparian lift — GATED by the local climate: a river greens its banks only
      // where the climate already supports vegetation. An exotic river crossing a
      // desert (which "couldn't start there") leaves the desert dry. See note.
      const riparian =
        W_RIVER * Math.exp(-distRiver[i] / RIVER_SCALE) * smoothstep(0.18, 0.42, base);

      const lift = maritime > riparian ? maritime : riparian;
      const m = base + (1 - base) * lift;
      moisture[i] = m < 0 ? 0 : m > 1 ? 1 : m;
    }
  }

  return { moisture, above, isLand };
}

// Temperature from latitude (cos) and an altitude lapse; cross with moisture on a
// Whittaker-style square to pick the biome. Thresholds line up with the gradient
// the earlier per-pixel shader used, so the zones read the same — just crisp.
function classify(moisture, above, isLand, W, H, clim) {
  const biome = new Uint8Array(W * H).fill(BIOME.NONE);
  const lapse = clim.lapse;
  const vs = clim.vegShift; // shifts the wet/dry class cuts: − greens, + dries
  for (let y = 0; y < H; y++) {
    const latRad = (90 - ((y + 0.5) / H) * 180) * Math.PI / 180;
    const seaT = Math.max(0, Math.cos(latRad));
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!isLand[i]) continue;
      const t = clamp01(seaT - Math.max(0, above[i]) / lapse);
      const m = moisture[i];
      biome[i] =
        t < 0.10 ? BIOME.ICE :
        t < 0.37 ? (m < 0.35 + vs ? BIOME.TUNDRA : BIOME.TAIGA) :
        t < 0.63 ? (m < 0.40 + vs ? BIOME.STEPPE : BIOME.TEMPERATE_FOREST) :
        m < 0.235 + vs ? BIOME.DESERT :
        m < 0.615 + vs ? BIOME.SAVANNA :
        BIOME.TROPICAL_FOREST;
    }
  }
  return biome;
}

// ---- polygonisation -------------------------------------------------------

// One MultiPolygon Feature per biome class. For each class we contour its binary
// cell mask (marching squares at 0.5) and XOR the closed rings into filled
// polygons-with-holes — the same even-odd assembly buildLand uses for the coast,
// which is why adjacent classes share edges exactly and enclosed patches cut clean
// holes. A class is always bounded by other land / ocean (never the unbounded
// background), so no world-spanning ring is needed to fix parity.
function polygonize(biome, W, H) {
  const N = W * H;
  const features = [];
  const mask = new Float32Array(N);

  for (const c of CLASS_IDS) {
    let any = false;
    for (let i = 0; i < N; i++) {
      const on = biome[i] === c ? 1 : 0;
      mask[i] = on;
      if (on) any = true;
    }
    if (!any) continue;

    const rings = marchingSquares(mask, W, H, 0.5);
    if (!rings.length) continue;
    const polys = rings.map((r) => [r.closed ? r : [...r, r[0]]]);

    let geom = [];
    try {
      geom = polygonClipping.xor(...polys); // even-odd → MultiPolygon coordinates
    } catch {
      geom = []; // a degenerate ring can trip the clipper; skip this class cleanly
    }
    if (geom.length) {
      features.push({
        type: "Feature",
        properties: { biome: c },
        geometry: { type: "MultiPolygon", coordinates: geom },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

// ---- helpers --------------------------------------------------------------

// Hermite smoothstep: 0 below e0, 1 above e1, an S-curve between. Used to gate the
// riparian lift on the local climate so river banks green smoothly, not abruptly.
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Base moisture from the planetary circulation, 0..1: a wet equatorial bump and a
// wet mid-latitude bump over a low base, the dry subtropics left in the gap, and a
// poleward roll-off — which puts the deserts near ±25–35° and forests near 0° and ~50°.
// The equatorial belt width, mid-latitude rainfall and an overall wetness multiplier
// are panel knobs (clim.eqSigma / midlatCoef / rainfallMul).
function latitudeBand(lat, clim) {
  const a = Math.abs(lat);
  const equator = Math.exp(-((a / clim.eqSigma) ** 2));
  const midlat = Math.exp(-(((a - 52) / 18) ** 2));
  let m = (0.18 + 0.8 * equator + clim.midlatCoef * midlat) * clim.rainfallMul;
  if (a > 72) m *= Math.max(0.2, 1 - (a - 72) / 25);
  return m > 1 ? 1 : m;
}

