/* ------------------------------------------------------------------ *
 *  Inversia — generation worker (Phase 4–5)
 *
 *  Keeps feature generation off the main thread. It decodes the global
 *  elevation field once (src/world/field.js) and, on each `generate` request,
 *  runs the coast/lake pass (src/world/gen/coast.js) and the hydrology pass
 *  (src/world/gen/hydro.js), then posts the resulting GeoJSON back. Later phases
 *  (countries, cities) add more passes here over the same cached field.
 *
 *  CACHING. Two passes are expensive and depend only on the water line + inversion:
 *    - the coast/lake analysis (marching squares + flood-fill),
 *    - the hydrology flow field (priority-flood + D8 + accumulation).
 *  We memoise each by a small signature so that nudging just the lake-size floor
 *  or the river threshold reuses the heavy work and only re-filters/re-extracts.
 *
 *  Protocol:
 *    main → worker : { type:"generate", id, water, invert, minSize, threshold,
 *                      seed, count, areaSkew, ambition, ridge, river, seaCross,
 *                      density, spacing }
 *    worker → main : { type:"progress", id, stage }              // narration
 *                    { type:"layer", id, name, data, count }     // one pass landed
 *                    { type:"done",  id, stats }                 // run finished
 *                    { type:"error", id, message }
 *  STREAMING. Rather than one terminal `features` post, the worker streams each
 *  pass's GeoJSON as a `layer` message the instant that pass finishes (coast →
 *  rivers → biome → countries → cities → naming), yielding the thread between
 *  posts so the main thread can paint that layer before the next (blocking) pass
 *  runs. This is what lets a full rebuild visibly BUILD UP. The naming pass
 *  mutates cities/rivers/lakes in place (adds `name`), so those three are
 *  re-posted after it — identical geometry, now carrying labels. `count` rides on
 *  the four counted passes (lakes, rivers, countries, cities) for the live tally.
 *  The `id` lets the main thread ignore stale responses (and the worker abort
 *  mid-stream) when a newer request has been issued — newest wins.
 * ------------------------------------------------------------------ */

import { loadField } from "./field.js";
import { generate } from "./gen/coast.js";
import { computeFlow, extractRivers } from "./gen/hydro.js";
import { computeCountries } from "./gen/countries.js";
import { computeCities } from "./gen/cities.js";
import { computeBiomes } from "./gen/biome.js";
import { nameWorld } from "./names.js";
import { CLIMATE_FIELDS } from "./recipe.js";

let fieldPromise = null;
const field = () => (fieldPromise ??= loadField());

// Heavy-result caches, keyed by the params they actually depend on.
let coastCache = { sig: "", coast: null, land: null, lakes: null, stats: null };
let flowCache = { sig: "", flow: null };
let countryCache = { sig: "", countries: null, owner: null, isLand: null, stats: null };
let cityCache = { sig: "", cities: null, stats: null };
let biomeCache = { sig: "", biomes: null };

// The newest request id seen. Each pass checks `fresh()` before its (blocking)
// work and before every post, so a superseded run bails mid-stream — newest wins.
let latest = 0;

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "generate") return;
  latest = msg.id;
  const fresh = () => msg.id === latest;

  // Yield the worker thread so the main thread can paint the layer we just posted
  // before the next (synchronous, blocking) pass seizes the thread again.
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  // Narrate which pass is about to run (drives the snap path's single-line
  // loader). Only the passes that actually execute emit a step — the cache guards
  // below skip the unchanged ones — so it shows exactly what's being recomputed.
  const step = (stage) => { if (fresh()) self.postMessage({ type: "progress", id: msg.id, stage }); };

  // Stream one pass's GeoJSON the instant it's ready, then yield. `count` rides on
  // the four counted passes for the main thread's live tally.
  const postLayer = async (name, data, count) => {
    if (!fresh()) return;
    self.postMessage({ type: "layer", id: msg.id, name, data, count });
    await yieldTick();
  };

  try {
    const f = await field();

    // coast + lakes depend on water / invert / lake-size floor
    const coastSig = `${msg.water}|${msg.invert ? 1 : 0}|${msg.minSize}`;
    if (coastSig !== coastCache.sig) {
      step("coast");
      const { coast, land, lakes, stats } = generate(f, {
        water: msg.water,
        invert: msg.invert,
        minSize: msg.minSize,
      });
      coastCache = { sig: coastSig, coast, land, lakes, stats };
    }
    if (!fresh()) return;
    await postLayer("coast", coastCache.coast);
    await postLayer("land", coastCache.land);
    await postLayer("lakes", coastCache.lakes, coastCache.stats.lakes);

    // the hydrology flow field depends only on water / invert; the threshold is a
    // cheap post-filter, so a threshold-only change reuses the cached flow.
    const flowSig = `${msg.water}|${msg.invert ? 1 : 0}`;
    if (flowSig !== flowCache.sig) {
      step("rivers");
      flowCache = { sig: flowSig, flow: computeFlow(f, { water: msg.water, invert: msg.invert }) };
    }
    const { rivers, stats: riverStats } = extractRivers(flowCache.flow, {
      threshold: msg.threshold,
    });
    await postLayer("rivers", rivers, riverStats.rivers);

    // the biome / land-cover zones depend only on water + invert (the same
    // geometry the coast does), so they're memoised on that signature and reused
    // whenever only the river threshold / country / city knobs move.
    const biomeSig = [msg.water, msg.invert ? 1 : 0, ...CLIMATE_FIELDS.map((k) => msg[k])].join("|");
    if (biomeSig !== biomeCache.sig) {
      step("biome");
      const { biomes } = computeBiomes(f, flowCache.flow, {
        water: msg.water,
        invert: msg.invert,
        ...Object.fromEntries(CLIMATE_FIELDS.map((k) => [k, msg[k]])),
      });
      biomeCache = { sig: biomeSig, biomes };
    }
    await postLayer("biomes", biomeCache.biomes);

    // countries grow over the field, taking the cached flow as a river-border
    // affinity. They depend on water/invert (the field) plus the seed and every
    // country knob, so they re-run only when one of those actually moves.
    const countrySig =
      `${msg.water}|${msg.invert ? 1 : 0}|${msg.seed}|${msg.count}|${msg.areaSkew}|${msg.ambition}|` +
      `${msg.ridge}|${msg.river}|${msg.seaCross}|${msg.minArea}|${msg.seaReach}|${msg.riverBorders}`;
    if (countrySig !== countryCache.sig) {
      step("countries");
      const { countries, owner, isLand, stats } = computeCountries(f, flowCache.flow, {
        water: msg.water,
        invert: msg.invert,
        seed: msg.seed,
        count: msg.count,
        areaSkew: msg.areaSkew,
        ambition: msg.ambition,
        ridge: msg.ridge,
        river: msg.river,
        seaCross: msg.seaCross,
        minArea: msg.minArea,
        seaReach: msg.seaReach,
        riverBorders: msg.riverBorders,
      });
      countryCache = { sig: countrySig, countries, owner, isLand, stats };
    }
    await postLayer("countries", countryCache.countries, countryCache.stats.countries);

    // cities sit on habitable land and take their allegiance from the country
    // owner grid, so they depend on everything the countries do (folded into
    // countrySig) plus their own placement knobs — nothing else.
    const citySig =
      `${countrySig}|${msg.density}|${msg.spacing}|` +
      `${msg.coastPull}|${msg.riverPull}|${msg.lowland}|${msg.bigCityShare}`;
    if (citySig !== cityCache.sig) {
      step("cities");
      const { cities, stats } = computeCities(
        f, flowCache.flow,
        { owner: countryCache.owner, isLand: countryCache.isLand },
        {
          water: msg.water, invert: msg.invert, density: msg.density, spacing: msg.spacing,
          coastPull: msg.coastPull, riverPull: msg.riverPull,
          lowland: msg.lowland, bigCityShare: msg.bigCityShare,
        },
      );
      cityCache = { sig: citySig, cities, stats };
    }
    await postLayer("cities", cityCache.cities, cityCache.stats.cities);

    // Phase 9: name everything deterministically from the seed + geography. This
    // MUTATES the city/river/lake features (adds `name` + `family`) and returns a
    // fresh country-label point layer. Rivers are re-extracted every call, so we
    // re-name unconditionally rather than caching — it's a cheap O(N) pass next to
    // the generation work above, and keeps the freshly-extracted rivers named.
    step("naming");
    const { countryLabels, oceanLabels, continentLabels } = nameWorld({
      seed: msg.seed,
      owner: countryCache.owner,
      isLand: countryCache.isLand,
      W: f.W, H: f.H,
      cities: cityCache.cities,
      rivers,
      lakes: coastCache.lakes,
    });
    await postLayer("countryLabels", countryLabels);
    await postLayer("oceanLabels", oceanLabels);
    await postLayer("continentLabels", continentLabels);
    // naming mutated these three in place — re-post so the label layers pick up the
    // freshly-written `name` property. Geometry is identical (a silent MapLibre diff).
    await postLayer("cities", cityCache.cities, cityCache.stats.cities);
    await postLayer("rivers", rivers, riverStats.rivers);
    await postLayer("lakes", coastCache.lakes, coastCache.stats.lakes);

    if (fresh()) {
      self.postMessage({
        type: "done",
        id: msg.id,
        stats: { ...coastCache.stats, ...riverStats, ...countryCache.stats, ...cityCache.stats },
      });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
