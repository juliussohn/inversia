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
import { LAYER_TOGGLES } from "./styles.js";

/**
 * @param {object}   opts
 * @param {HTMLElement} opts.container  where to mount the pane
 * @param {object}   opts.recipe        the live recipe (mutated in place)
 * @param {(recipe:object, ev:object)=>void} opts.onChange  fired on every recipe edit
 * @param {object}   [opts.view]        view-preference section (layer toggles)
 * @param {Record<string,boolean>} opts.view.visibility  toggle key → on/off (mutated)
 * @param {(visibility:object)=>void} opts.view.onChange  fired on every toggle edit
 * @param {object}   [opts.schema]      defaults to RECIPE_SCHEMA
 * @returns {{ pane: Pane, refresh: ()=>void }}
 */
export function createPanel({ container, recipe, onChange, view, schema = RECIPE_SCHEMA }) {
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
    // Per-folder hook (not a global one) so recipe edits drive the renderer +
    // URL while the view-only Layers folder below stays out of that path.
    folder.on("change", (ev) => onChange?.(recipe, ev));
  }

  // View-level layer visibility — booleans render as checkboxes. NOT part of the
  // recipe, so these fire `view.onChange` (toggle a layer) instead of `onChange`.
  if (view?.visibility) {
    const folder = pane.addFolder({ title: "Layers" });
    for (const t of LAYER_TOGGLES) {
      if (typeof view.visibility[t.key] !== "boolean") view.visibility[t.key] = true;
      folder.addBinding(view.visibility, t.key, { label: t.label });
    }
    folder.on("change", () => view.onChange?.(view.visibility));
  }

  // Re-sync every control to the recipe (e.g. after loading a hash/JSON).
  const refresh = () => pane.refresh();

  return { pane, refresh };
}
