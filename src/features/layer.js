import { loadField } from "./field.js";
import { generateSeeds, generateBorders } from "./generate.js";

/* ------------------------------------------------------------------ *
 *  Inversia — feature layer registry
 *
 *  The single seam between the procedural world and the renderers. It owns the
 *  global elevation field, a REGISTRY of feature types, and the regeneration
 *  policy. The renderers never touch generators directly: they ask the layer
 *  for `getFeatures()` and draw whatever's there.
 *
 *  Adding a feature type (cities, lakes, rivers…) means adding ONE registry
 *  entry — a generator + how its output reacts to the world — and a draw case
 *  in the overlay. Nothing else changes.
 *
 *  Regeneration is debounced: dragging the water level fires many param
 *  changes a second, so we coalesce them and only regrow once the slider
 *  settles. (Generation is pure and self-contained — drop it onto a Web Worker
 *  here when the grid grows past what a frame budget allows.)
 * ------------------------------------------------------------------ */

const REGISTRY = [
  {
    id: "borders",
    type: "borders",
    label: "State borders",
    defaultOn: true,
    // seeds change only when the *world* flips (invert); regrow on any water move
    seedKey: (p) => `${p.invert}`,
    makeSeeds: (field, p) => generateSeeds(field, { invert: p.invert, sea: p.sea, count: 70 }),
    generate: (field, p, seeds) => generateBorders(field, p, seeds),
  },
];

export function createFeatureLayer(params, { debounceMs = 180, onUpdate } = {}) {
  let field = null;
  const enabled = new Map(REGISTRY.map((t) => [t.id, t.defaultOn]));
  const seedCache = new Map(); // id → { key, seeds }
  let features = [];           // latest geometry, what the overlay draws
  let timer = 0;

  // kick off the one-time field load; regenerate as soon as it lands
  loadField().then((f) => { field = f; if (field) regen(); });

  function typesOn() { return REGISTRY.filter((t) => enabled.get(t.id)); }

  function regen() {
    if (!field) return;
    const snap = { invert: params.invert, sea: params.sea };
    const out = [];
    for (const t of typesOn()) {
      // reuse seeds unless their key (the world identity) changed
      const key = t.seedKey(snap);
      let cached = seedCache.get(t.id);
      if (!cached || cached.key !== key) {
        cached = { key, seeds: t.makeSeeds(field, snap) };
        seedCache.set(t.id, cached);
      }
      const geom = t.generate(field, snap, cached.seeds);
      out.push({ id: t.id, type: t.type, kind: geom.kind, data: geom.data });
    }
    features = out;
    onUpdate && onUpdate(features);
  }

  // coalesce a burst of slider events into a single regrow
  function invalidate() {
    if (!field) return;
    clearTimeout(timer);
    timer = setTimeout(regen, debounceMs);
  }

  return {
    getFeatures: () => features,
    invalidate,
    // expose the registry so the UI can build a toggle per feature type
    types: () => REGISTRY.map((t) => ({ id: t.id, label: t.label, on: enabled.get(t.id) })),
    setEnabled(id, on) {
      if (!enabled.has(id)) return;
      enabled.set(id, on);
      regen();
    },
  };
}
