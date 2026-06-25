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
 *    main → worker : { type:"generate", id, water, invert, minSize, threshold }
 *    worker → main : { type:"features", id, coast, lakes, rivers, stats }
 *                    { type:"error",    id, message }
 *  The `id` lets the main thread ignore stale responses when a newer request has
 *  already been issued (e.g. fast successive slider settles).
 * ------------------------------------------------------------------ */

import { loadField } from "./field.js";
import { generate } from "./gen/coast.js";
import { computeFlow, extractRivers } from "./gen/hydro.js";

let fieldPromise = null;
const field = () => (fieldPromise ??= loadField());

// Heavy-result caches, keyed by the params they actually depend on.
let coastCache = { sig: "", coast: null, land: null, lakes: null, stats: null };
let flowCache = { sig: "", flow: null };

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

    self.postMessage({
      type: "features",
      id: msg.id,
      coast: coastCache.coast,
      land: coastCache.land,
      lakes: coastCache.lakes,
      rivers,
      stats: { ...coastCache.stats, ...riverStats },
    });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
