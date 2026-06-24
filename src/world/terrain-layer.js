/* ------------------------------------------------------------------ *
 *  Inversia — inverted terrain as a MapLibre custom layer (Phase 2)
 *
 *  Ports the live inverted-hypsometric renderer out of the bespoke slippy map
 *  (src/map.js) and into a MapLibre `type: "custom"` layer that draws straight
 *  into MapLibre's own GL context, synced to its mercator camera. The pixel
 *  pipeline is unchanged — it reuses the SHARED fragment shader and Terrarium
 *  tile streaming from src/terrain.js — so the world reads identically to the
 *  legacy map. Only the vertex stage and the camera differ: instead of our own
 *  pan/zoom math we place each tile in mercator [0,1] space and let MapLibre's
 *  projection matrix carry it to the screen.
 *
 *  Water level / invert / relief come live from the world recipe as shader
 *  uniforms, so dragging a slider is instant with no re-fetch — exactly as
 *  before. Tiles are chosen for the current camera each frame; missing ones
 *  fall back to an already-loaded ancestor and stream in, triggering a repaint.
 *
 *  Mercator only by design — globe projection is Phase 3.
 * ------------------------------------------------------------------ */

import {
  TILE, MAX_TILE_Z, FRAG, clamp,
  lonToWX, latToWY,
  linkProgram, createTileCache,
} from "../terrain.js";

// Vertex stage unique to the MapLibre custom layer: a unit quad placed into a
// tile's mercator rectangle, then projected by MapLibre's matrix. `uUv` lets a
// quad sample a sub-rectangle of an ancestor texture (fallback while a child
// tile streams in) — same trick the slippy map used.
const VERT = `#version 300 es
in vec2 a_uv;
uniform mat4 uMatrix;
uniform vec4 uRectMerc; // x0, y0, sizeX, sizeY  (mercator 0..1)
uniform vec4 uUv;       // uvOffset.xy, uvScale.zw
out vec2 vUv;
void main() {
  vec2 merc = uRectMerc.xy + a_uv * uRectMerc.zw;
  vUv = uUv.xy + a_uv * uUv.zw;
  gl_Position = uMatrix * vec4(merc, 0.0, 1.0);
}`;

/**
 * Build the terrain custom layer.
 * @param {object} recipe  live world recipe; reads `recipe.world.{invert,water,relief}`
 * @returns {import("maplibre-gl").CustomLayerInterface}
 */
export function createTerrainLayer(recipe) {
  let map = null;
  let gl = null;
  let program = null;
  let quad = null;
  let aUv = -1;
  let tiles = null;
  const U = {};

  function uniforms() {
    return {
      invert: recipe.world.invert ? 1 : 0,
      sea: recipe.world.water,
      relief: recipe.world.relief,
    };
  }

  // Visible mercator AABB for the current camera. We unproject the four viewport
  // corners, convert to mercator [0,1], and unwrap each around the centre so a
  // view straddling the antimeridian stays a contiguous range (possibly outside
  // [0,1] — the tile loop wraps it). Handles rotation by taking the bounding box.
  function visibleRange() {
    const cont = map.getContainer();
    const W = cont.clientWidth, H = cont.clientHeight;
    const c = map.getCenter();
    const cwx = lonToWX(c.lng);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of [[0, 0], [W, 0], [W, H], [0, H]]) {
      const ll = map.unproject([px, py]);
      let d = lonToWX(ll.lng) - cwx;
      d = ((d % 1) + 1.5) % 1 - 0.5;          // nearest wrap to centre, in [-0.5,0.5)
      const wx = cwx + d;
      const wy = clamp(latToWY(ll.lat), 0, 1);
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
    return { minX, maxX, minY, maxY };
  }

  function drawTile(matrix, x0, y0, sizeX, sizeY, t) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform4f(U.rect, x0, y0, sizeX, sizeY);
    gl.uniform4f(U.uv, t.ox || 0, t.oy || 0, t.s || 1, t.s || 1);
    gl.uniformMatrix4fv(U.matrix, false, matrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  return {
    id: "inversia-terrain",
    type: "custom",
    renderingMode: "2d",

    onAdd(m, glCtx) {
      map = m;
      gl = glCtx;
      program = linkProgram(gl, VERT, FRAG);

      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
        gl.STATIC_DRAW,
      );
      aUv = gl.getAttribLocation(program, "a_uv");

      U.matrix = gl.getUniformLocation(program, "uMatrix");
      U.rect = gl.getUniformLocation(program, "uRectMerc");
      U.uv = gl.getUniformLocation(program, "uUv");
      U.tile = gl.getUniformLocation(program, "uTile");
      U.invert = gl.getUniformLocation(program, "uInvert");
      U.sea = gl.getUniformLocation(program, "uSea");
      U.relief = gl.getUniformLocation(program, "uRelief");
      U.texel = gl.getUniformLocation(program, "uTexel");

      // Repaint as tiles stream in — MapLibre only renders on demand.
      tiles = createTileCache(gl, () => map.triggerRepaint());
    },

    onRemove() {
      if (gl && program) gl.deleteProgram(program);
      if (gl && quad) gl.deleteBuffer(quad);
      program = quad = tiles = null;
    },

    render(_gl, args) {
      // mainMatrix on the default projection data projects mercator [0,1]
      // coordinates straight to clip space under the mercator projection.
      const matrix = args.defaultProjectionData.mainMatrix;

      tiles.tick();

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      const { invert, sea, relief } = uniforms();
      gl.uniform1i(U.tile, 0);
      gl.uniform2f(U.texel, 1 / TILE, 1 / TILE);
      gl.uniform1f(U.invert, invert);
      gl.uniform1f(U.sea, sea);
      gl.uniform1f(U.relief, relief);

      // Terrarium tiles are 256px; MapLibre zoom is defined on 512px tiles, so a
      // tile zoom of round(zoom)+1 keeps each tile ~256 CSS px on screen — the
      // same on-screen density the legacy slippy map rendered at.
      const Z = clamp(Math.round(map.getZoom()) + 1, 0, MAX_TILE_Z);
      const n = 1 << Z;
      const { minX, maxX, minY, maxY } = visibleRange();

      const txa = Math.floor(minX * n), txb = Math.floor(maxX * n);
      const tya = Math.max(0, Math.floor(minY * n));
      const tyb = Math.min(n - 1, Math.floor(maxY * n));

      const wanted = [];
      for (let ty = tya; ty <= tyb; ty++) {
        for (let rawTx = txa; rawTx <= txb; rawTx++) {
          const dx = ((rawTx % n) + n) % n;     // wrap longitude
          const key = `${Z}/${dx}/${ty}`;
          const e = tiles.get(key);
          let t = null;
          if (e && e.tex) {
            tiles.touch(e);
            t = { tex: e.tex, ox: 0, oy: 0, s: 1 };
          } else {
            t = tiles.ancestor(Z, dx, ty);       // coarse fallback while loading
            wanted.push([dx, ty]);
          }
          if (t) {
            // place this tile (using its UNWRAPPED column so it lands in the
            // right copy of the world) in mercator space
            drawTile(matrix, rawTx / n, ty / n, 1 / n, 1 / n, t);
          }
        }
      }

      if (wanted.length) {
        const cxw = ((minX + maxX) / 2) * n, cyw = ((minY + maxY) / 2) * n;
        wanted.sort(
          (a, b) =>
            (a[0] - cxw) ** 2 + (a[1] - cyw) ** 2 -
            ((b[0] - cxw) ** 2 + (b[1] - cyw) ** 2),
        );
        for (const [dx, ty] of wanted) tiles.request(Z, dx, ty);
        map.triggerRepaint();                    // keep pulling until the view is filled
      }
      tiles.evict();
    },
  };
}
