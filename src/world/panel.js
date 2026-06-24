/* ------------------------------------------------------------------ *
 *  Inversia — auto-generated Tweakpane panel
 *
 *  Walks `RECIPE_SCHEMA`, makes one folder per group and one binding per field,
 *  bound directly to the live recipe object. Any change fires `onChange(recipe)`
 *  so the page can push the value into the renderer and the URL hash. Adding a
 *  field to the schema surfaces a control here automatically — no edits needed.
 * ------------------------------------------------------------------ */

import { Pane } from "tweakpane";
import { RECIPE_SCHEMA } from "./recipe.js";

/**
 * @param {object}   opts
 * @param {HTMLElement} opts.container  where to mount the pane
 * @param {object}   opts.recipe        the live recipe (mutated in place)
 * @param {(recipe:object, ev:object)=>void} opts.onChange  fired on every edit
 * @param {object}   [opts.schema]      defaults to RECIPE_SCHEMA
 * @returns {{ pane: Pane, refresh: ()=>void }}
 */
export function createPanel({ container, recipe, onChange, schema = RECIPE_SCHEMA }) {
  const pane = new Pane({ container, title: "World recipe" });

  for (const [group, g] of Object.entries(schema)) {
    const folder = pane.addFolder({ title: g.label || group });
    const bag = (recipe[group] ??= {});
    for (const [key, spec] of Object.entries(g.fields)) {
      if (bag[key] == null) bag[key] = spec.default;
      const opts = { label: spec.label || key };
      if (spec.type === "int" || spec.type === "float") {
        if (spec.min != null) opts.min = spec.min;
        if (spec.max != null) opts.max = spec.max;
        if (spec.step != null) opts.step = spec.step;
      }
      if (spec.type === "int") opts.step = opts.step ?? 1;
      folder.addBinding(bag, key, opts);
    }
  }

  // One global hook so a single edit updates both renderer state and the URL.
  pane.on("change", (ev) => onChange?.(recipe, ev));

  // Re-sync every control to the recipe (e.g. after loading a hash/JSON).
  const refresh = () => pane.refresh();

  return { pane, refresh };
}
