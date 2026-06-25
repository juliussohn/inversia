/* ------------------------------------------------------------------ *
 *  Inversia — generation worker (Phase 4)
 *
 *  Keeps feature generation off the main thread. It decodes the global
 *  elevation field once (src/world/field.js) and, on each `generate` request,
 *  runs the coast/lake pass (src/world/gen/coast.js) and posts the resulting
 *  GeoJSON back. Later phases (rivers, countries, cities) add more passes here
 *  over the same cached field.
 *
 *  Protocol:
 *    main → worker : { type:"generate", id, water, invert, minSize }
 *    worker → main : { type:"features", id, coast, lakes, stats }
 *                    { type:"error",    id, message }
 *  The `id` lets the main thread ignore stale responses when a newer request has
 *  already been issued (e.g. fast successive slider settles).
 * ------------------------------------------------------------------ */

import { loadField } from "./field.js";
import { generate } from "./gen/coast.js";

let fieldPromise = null;
const field = () => (fieldPromise ??= loadField());

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "generate") return;
  try {
    const f = await field();
    const { coast, lakes, stats } = generate(f, {
      water: msg.water,
      invert: msg.invert,
      minSize: msg.minSize,
    });
    self.postMessage({ type: "features", id: msg.id, coast, lakes, stats });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
