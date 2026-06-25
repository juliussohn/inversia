/* ------------------------------------------------------------------ *
 *  Inversia — the world recipe (typed config spine)
 *
 *  ONE typed parameter object describes a whole world: the seed, the global
 *  world knobs (invert / water level / relief), and per-domain groups for the
 *  features that later phases generate (countries, cities, rivers, lakes).
 *
 *  The recipe is the single source of truth. Everything else hangs off it:
 *    - the live renderer reads `recipe.world.*` as shader inputs,
 *    - the Tweakpane panel is AUTO-GENERATED from `RECIPE_SCHEMA` (no per-field
 *      UI code — add a field here and a control appears),
 *    - the URL hash + JSON save formats are derived by the codecs below.
 *
 *  To keep all of that automatic, each field is declared once in
 *  `RECIPE_SCHEMA` with its type + range + default. `defaultRecipe()` projects
 *  the schema down to a plain nested value object (what the app mutates), and
 *  the codecs walk the schema so they never drift from the live shape.
 *
 *  Placeholder groups (countries/cities/rivers/lakes) carry just enough knobs
 *  to be real today; each phase fleshes out its own group later.
 * ------------------------------------------------------------------ */

/**
 * Field types the schema understands. Each maps to a Tweakpane binding and a
 * codec encode/decode pair:
 *   bool  → checkbox            (URL: 1/0)
 *   int   → integer slider      (URL: rounded number)
 *   float → float slider        (URL: number, trimmed)
 */
export const RECIPE_SCHEMA = {
  seed: {
    label: "Seed",
    fields: {
      seed: { type: "int", default: 1337, min: 0, max: 999999, step: 1, label: "Seed" },
    },
  },

  world: {
    label: "World",
    fields: {
      invert: { type: "bool", default: true, label: "Invert (Inversia)" },
      water: { type: "float", default: 0, min: -8000, max: 6000, step: 25, label: "Water level (m)" },
      relief: { type: "float", default: 1.0, min: 0, max: 2, step: 0.05, label: "Relief" },
    },
  },

  // ---- placeholder groups — fleshed out as each phase lands ----
  countries: {
    label: "Countries",
    fields: {
      count: { type: "int", default: 40, min: 4, max: 256, step: 1, label: "Count" },
      areaSkew: { type: "float", default: 0.5, min: 0.3, max: 1, step: 0.05, label: "Size↔area coupling" },
      ambition: { type: "float", default: 0.5, min: 0, max: 1, step: 0.05, label: "Size spread" },
      ridge: { type: "float", default: 0.6, min: 0, max: 1, step: 0.05, label: "Ridge affinity" },
      river: { type: "float", default: 0.6, min: 0, max: 1, step: 0.05, label: "River affinity" },
      seaCross: { type: "float", default: 0.4, min: 0, max: 1, step: 0.05, label: "Sea-crossing cost" },
    },
  },

  cities: {
    label: "Cities",
    fields: {
      density: { type: "float", default: 0.5, min: 0, max: 1, step: 0.05, label: "Density" },
      spacing: { type: "float", default: 0.5, min: 0, max: 1, step: 0.05, label: "Min spacing" },
    },
  },

  rivers: {
    label: "Rivers",
    fields: {
      threshold: { type: "float", default: 0.5, min: 0, max: 1, step: 0.05, label: "Flow threshold" },
    },
  },

  lakes: {
    label: "Lakes",
    fields: {
      minSize: { type: "float", default: 0.2, min: 0, max: 1, step: 0.05, label: "Min size" },
    },
  },
};

// ---- schema helpers ------------------------------------------------------

/** Iterate every field as { group, key, spec }. Used by the codecs + panel. */
export function* eachField(schema = RECIPE_SCHEMA) {
  for (const [group, g] of Object.entries(schema)) {
    for (const [key, spec] of Object.entries(g.fields)) {
      yield { group, key, spec };
    }
  }
}

/** Coerce a raw value to its declared type, clamped to the field's range. */
function coerce(spec, raw) {
  if (spec.type === "bool") return !!raw;
  let n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) n = spec.default;
  if (spec.type === "int") n = Math.round(n);
  if (spec.min != null) n = Math.max(spec.min, n);
  if (spec.max != null) n = Math.min(spec.max, n);
  return n;
}

/** Build a fresh recipe (plain nested value object) from the schema defaults. */
export function defaultRecipe(schema = RECIPE_SCHEMA) {
  const r = {};
  for (const { group, key, spec } of eachField(schema)) {
    (r[group] ??= {})[key] = spec.default;
  }
  return r;
}

/** Deep-clone a recipe (plain data, so JSON round-trip is enough). */
export function cloneRecipe(recipe) {
  return JSON.parse(JSON.stringify(recipe));
}

// ---- recipe ⇄ URL hash ---------------------------------------------------
// Compact, human-pokeable hash. Only values that differ from the default are
// written, so a pristine world has an empty hash and a tweaked one stays short.
// Keys are flattened as `group.key`; booleans encode as 1/0.

export function encodeHash(recipe, schema = RECIPE_SCHEMA) {
  const p = new URLSearchParams();
  for (const { group, key, spec } of eachField(schema)) {
    const v = recipe?.[group]?.[key];
    if (v == null) continue;
    const def = spec.default;
    if (spec.type === "bool") {
      if (!!v !== !!def) p.set(`${group}.${key}`, v ? "1" : "0");
    } else if (v !== def) {
      // trim float noise; ints stay whole
      p.set(`${group}.${key}`, spec.type === "int" ? String(Math.round(v)) : trimFloat(v));
    }
  }
  return p.toString();
}

export function decodeHash(hash, schema = RECIPE_SCHEMA) {
  const recipe = defaultRecipe(schema);
  const str = String(hash || "").replace(/^#/, "");
  if (!str) return recipe;
  const p = new URLSearchParams(str);
  for (const { group, key, spec } of eachField(schema)) {
    const raw = p.get(`${group}.${key}`);
    if (raw == null) continue;
    recipe[group][key] = spec.type === "bool" ? raw === "1" : coerce(spec, raw);
  }
  return recipe;
}

function trimFloat(n) {
  // up to 4 decimals, no trailing zeros (e.g. 1.5, 0.05, -8000)
  return parseFloat(n.toFixed(4)).toString();
}

// ---- recipe ⇄ JSON (save format) ----------------------------------------
// The recipe doubles as the save format. We re-coerce on load so an old or
// hand-edited file can't smuggle in out-of-range / wrong-typed values.

export function toJSON(recipe, pretty = true) {
  return JSON.stringify(recipe, null, pretty ? 2 : 0);
}

export function fromJSON(text, schema = RECIPE_SCHEMA) {
  let parsed;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return defaultRecipe(schema);
  }
  const recipe = defaultRecipe(schema);
  for (const { group, key, spec } of eachField(schema)) {
    const v = parsed?.[group]?.[key];
    if (v == null) continue;
    recipe[group][key] = spec.type === "bool" ? !!v : coerce(spec, v);
  }
  return recipe;
}
