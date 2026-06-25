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
 *    worker → main : { type:"features", id, coast, land, lakes, rivers,
 *                      countries, cities, countryLabels, stats }
 *                    { type:"error",    id, message }
 *  The `id` lets the main thread ignore stale responses when a newer request has
 *  already been issued (e.g. fast successive slider settles).
 * ------------------------------------------------------------------ */

import { loadField } from "./field.js";
import { generate } from "./gen/coast.js";
import { computeFlow, extractRivers } from "./gen/hydro.js";
import { computeCountries } from "./gen/countries.js";
import { computeCities } from "./gen/cities.js";
import { nameWorld } from "./names.js";

let fieldPromise = null;
const field = () => (fieldPromise ??= loadField());

// Heavy-result caches, keyed by the params they actually depend on.
let coastCache = { sig: "", coast: null, land: null, lakes: null, stats: null };
let flowCache = { sig: "", flow: null };
let countryCache = { sig: "", countries: null, owner: null, isLand: null, stats: null };
let cityCache = { sig: "", cities: null, stats: null };

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "generate") return;
  try {
    const f = await field();

    // coast + lakes depend on water / invert / lake-size floor
    const coastSig = `${msg.water}|${msg.invert ? 1 : 0}|${msg.minSize}`;
    if (coastSig !== coastCache.sig) {
      const { coast, land, lakes, stats } = generate(f, {
        water: msg.water,
        invert: msg.invert,
        minSize: msg.minSize,
      });
      coastCache = { sig: coastSig, coast, land, lakes, stats };
    }

    // the hydrology flow field depends only on water / invert; the threshold is a
    // cheap post-filter, so a threshold-only change reuses the cached flow.
    const flowSig = `${msg.water}|${msg.invert ? 1 : 0}`;
    if (flowSig !== flowCache.sig) {
      flowCache = { sig: flowSig, flow: computeFlow(f, { water: msg.water, invert: msg.invert }) };
    }
    const { rivers, stats: riverStats } = extractRivers(flowCache.flow, {
      threshold: msg.threshold,
    });

    // countries grow over the field, taking the cached flow as a river-border
    // affinity. They depend on water/invert (the field) plus the seed and every
    // country knob, so they re-run only when one of those actually moves.
    const countrySig =
      `${msg.water}|${msg.invert ? 1 : 0}|${msg.seed}|${msg.count}|${msg.areaSkew}|${msg.ambition}|` +
      `${msg.ridge}|${msg.river}|${msg.seaCross}`;
    if (countrySig !== countryCache.sig) {
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
      });
      countryCache = { sig: countrySig, countries, owner, isLand, stats };
    }

    // cities sit on habitable land and take their allegiance from the country
    // owner grid, so they depend on everything the countries do (folded into
    // countrySig) plus their own density/spacing knobs — nothing else.
    const citySig = `${countrySig}|${msg.density}|${msg.spacing}`;
    if (citySig !== cityCache.sig) {
      const { cities, stats } = computeCities(
        f, flowCache.flow,
        { owner: countryCache.owner, isLand: countryCache.isLand },
        { water: msg.water, invert: msg.invert, density: msg.density, spacing: msg.spacing },
      );
      cityCache = { sig: citySig, cities, stats };
    }

    // Phase 9: name everything deterministically from the seed + geography. This
    // MUTATES the city/river/lake features (adds `name` + `family`) and returns a
    // fresh country-label point layer. Rivers are re-extracted every call, so we
    // re-name unconditionally rather than caching — it's a cheap O(N) pass next to
    // the generation work above, and keeps the freshly-extracted rivers named.
    const { countryLabels } = nameWorld({
      seed: msg.seed,
      owner: countryCache.owner,
      isLand: countryCache.isLand,
      W: f.W, H: f.H,
      cities: cityCache.cities,
      rivers,
      lakes: coastCache.lakes,
    });

    self.postMessage({
      type: "features",
      id: msg.id,
      coast: coastCache.coast,
      land: coastCache.land,
      lakes: coastCache.lakes,
      rivers,
      countries: countryCache.countries,
      cities: cityCache.cities,
      countryLabels,
      stats: { ...coastCache.stats, ...riverStats, ...countryCache.stats, ...cityCache.stats },
    });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
