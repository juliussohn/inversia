/* ------------------------------------------------------------------ *
 *  Inversia — world bake + bundle (Phase 8)
 *
 *  "Download world" freezes the live, generator-driven world into a self-contained
 *  static bundle that reloads with NO worker and NO terrain generation — identical
 *  to look at, but inert. Two halves:
 *
 *   1. TERRAIN BAKE (the hybrid bake the plan calls for). The live map paints the
 *      inverted hypsometric terrain with a GL shader over streamed Terrarium tiles
 *      (src/world/terrain-layer.js). We can't ship that shader as "static data", so
 *      we run the SAME fragment shader (src/terrain.js `FRAG`) once per tile in an
 *      offscreen WebGL2 context, read the pixels back, and PNG-encode them into a
 *      small raster pyramid (z0..maxzoom). A baked world serves these as an ordinary
 *      MapLibre `raster` source — no custom layer, no tile streaming.
 *
 *   2. BUNDLE ASSEMBLY. The recipe, the current per-layer GeoJSON (coast / land /
 *      countries / lakes / rivers / cities), the view preferences, and the baked
 *      terrain pyramid go into one JSON object. It downloads as a single file and
 *      loads back through `bakedProtocolLoader` below.
 *
 *  Orientation note: the shared FRAG samples a Terrarium tile with its top row at
 *  the north edge (the live layer uploads tiles un-flipped). `readPixels` returns
 *  rows bottom-up, so we flip vertically on readback to get a north-up XYZ tile.
 * ------------------------------------------------------------------ */

import { FRAG, TILE, TILE_URL, linkProgram } from "../terrain.js";

export const BUNDLE_FORMAT = "inversia-world";
export const BUNDLE_VERSION = 1;

// Default depth of the baked pyramid. z0..z3 = 1+4+16+64 = 85 tiles: enough that
// the globe and regional zoom look right, small enough to bake in a few seconds
// and keep the bundle a sane size. Beyond maxzoom MapLibre overzooms the deepest
// tile (the same z4-source blockiness the plan already documents as deferred).
const DEFAULT_MAXZOOM = 3;

// Pass-through vertex stage: a full-viewport quad in clip space, emitting the tile
// UV. We flip V here so the framebuffer's TOP row samples the tile's north edge
// (texture v=0), matching how the live layer places an un-flipped Terrarium tile.
const BAKE_VERT = `#version 300 es
in vec2 a_pos;
out vec2 vUv;
void main() {
  vUv = vec2(a_pos.x, 1.0 - a_pos.y);
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

function loadTileImage(z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing tile → skip (rare; terrarium is global)
    img.src = TILE_URL(z, x, y);
  });
}

/**
 * Bake the inverted terrain into a static raster pyramid by running the live
 * fragment shader over Terrarium tiles offscreen.
 *
 * @param {object} recipe  reads `recipe.world.{invert,water,relief}` as the shader
 *   uniforms — the baked tiles capture exactly the current water line / inversion.
 * @param {object} [opts]
 * @param {number} [opts.maxzoom]   deepest baked level (default 3)
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<{tileSize:number, minzoom:number, maxzoom:number, tiles:Record<string,string>}>}
 *   `tiles` maps "z/x/y" → PNG data URL.
 */
export async function bakeTerrain(recipe, { maxzoom = DEFAULT_MAXZOOM, onProgress } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILE;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 unavailable — cannot bake terrain");

  const program = linkProgram(gl, BAKE_VERT, FRAG);
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {
    tile: gl.getUniformLocation(program, "uTile"),
    invert: gl.getUniformLocation(program, "uInvert"),
    sea: gl.getUniformLocation(program, "uSea"),
    relief: gl.getUniformLocation(program, "uRelief"),
    texel: gl.getUniformLocation(program, "uTexel"),
  };
  gl.uniform1i(U.tile, 0);
  gl.uniform2f(U.texel, 1 / TILE, 1 / TILE);
  gl.uniform1f(U.invert, recipe.world.invert ? 1 : 0);
  gl.uniform1f(U.sea, recipe.world.water);
  gl.uniform1f(U.relief, recipe.world.relief);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // NEAREST + clamp: identical to the live layer, so the packed elevation bytes
  // are never blended (linear filtering would corrupt the R*256+G+B/256 decode).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.viewport(0, 0, TILE, TILE);

  const pixels = new Uint8Array(TILE * TILE * 4);
  const out = document.createElement("canvas");
  out.width = out.height = TILE;
  const octx = out.getContext("2d");
  const imgData = octx.createImageData(TILE, TILE);
  const rowBytes = TILE * 4;

  const tiles = {};
  let total = 0;
  for (let z = 0; z <= maxzoom; z++) total += (1 << z) * (1 << z);
  let done = 0;

  for (let z = 0; z <= maxzoom; z++) {
    const n = 1 << z;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const img = await loadTileImage(z, x, y);
        if (img) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.readPixels(0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          // readPixels is bottom-up; copy rows in reverse for a north-up tile.
          for (let row = 0; row < TILE; row++) {
            const src = (TILE - 1 - row) * rowBytes;
            imgData.data.set(pixels.subarray(src, src + rowBytes), row * rowBytes);
          }
          octx.putImageData(imgData, 0, 0);
          tiles[`${z}/${x}/${y}`] = out.toDataURL("image/png");
        }
        onProgress?.(++done, total);
      }
    }
  }

  gl.deleteTexture(tex);
  gl.deleteBuffer(quad);
  gl.deleteProgram(program);
  // hint the context to release; the canvas is GC'd with this scope.
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  return { tileSize: TILE, minzoom: 0, maxzoom, tiles };
}

/**
 * Pack a downloadable world bundle. Pure data assembly — all the heavy lifting
 * (the terrain bake, gathering the live GeoJSON) happens at the call site.
 *
 * @param {object} args
 * @param {object} args.recipe   the world recipe
 * @param {object} args.view     `{ style, layerVisibility }` view preferences
 * @param {object} args.layers   per-layer GeoJSON FeatureCollections
 * @param {object} args.terrain  baked terrain pyramid from `bakeTerrain`
 * @param {string} args.savedAt  ISO timestamp (caller supplies it)
 */
export function assembleBundle({ recipe, view, layers, terrain, savedAt }) {
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, savedAt, recipe, view, layers, terrain };
}

/** True if a parsed object looks like one of our world bundles. */
export function isBundle(obj) {
  return !!obj && obj.format === BUNDLE_FORMAT && !!obj.terrain && !!obj.layers;
}

// 1×1 transparent PNG — served for any tile that failed to bake so MapLibre still
// gets a decodable image (the recipe-derived background shows through).
const TRANSPARENT_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/**
 * Build a MapLibre custom-protocol loader for a baked tile set. Register it with
 * `maplibregl.addProtocol("baked", bakedProtocolLoader(bundle.terrain.tiles))`, then
 * point a raster source at `tiles: ["baked://{z}/{x}/{y}"]`.
 */
export function bakedProtocolLoader(tiles) {
  return async (params) => {
    const m = /^baked:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error("bad baked tile url: " + params.url);
    const dataURL = tiles[`${m[1]}/${m[2]}/${m[3]}`];
    if (!dataURL) return { data: TRANSPARENT_PNG };
    const buf = await (await fetch(dataURL)).arrayBuffer();
    return { data: new Uint8Array(buf) };
  };
}
