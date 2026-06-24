/* ------------------------------------------------------------------ *
 *  Inversia — inverted terrain as a MapLibre custom layer (globe + mercator)
 *
 *  Ports the live inverted-hypsometric renderer out of the bespoke slippy map
 *  (legacy src/map.js) into a MapLibre `type: "custom"` layer that draws straight
 *  into MapLibre's own GL context, synced to its camera. The pixel pipeline is
 *  unchanged — it reuses the SHARED fragment shader and Terrarium tile streaming
 *  from src/terrain.js — so the world reads identically across the whole zoom
 *  range. Only the vertex stage and the camera differ.
 *
 *  Projection (Phase 3): instead of multiplying by our own matrix, the vertex
 *  shader calls MapLibre's `projectTile(mercator)` from the injected projection
 *  prelude (args.shaderData) and we feed it the projection uniforms straight from
 *  args.defaultProjectionData. That single call carries each vertex correctly
 *  under BOTH the globe and mercator projections (and the morph between them) —
 *  on the globe it bends the mercator point onto the unit sphere and clips the
 *  back hemisphere via the clipping-plane z it bakes into gl_Position. The prelude
 *  changes with the projection (shaderData.variantName), so we cache one compiled
 *  program per variant and rebuild lazily when it changes.
 *
 *  Two consequences of the globe drive the rest of this file:
 *   1. A flat 2-triangle quad would chord straight through the sphere, so each
 *      tile is drawn as a tessellated GRID — enough vertices for `projectTile` to
 *      sample the curve smoothly.
 *   2. When the globe doesn't fill the viewport, unprojecting the screen corners
 *      to pick visible tiles is unreliable, so while the projection is globe-ish
 *      we render the whole sphere at a capped zoom (the back half is clipped, the
 *      front is covered) and only fall back to the tight visible-AABB walk once
 *      we've morphed to (near-)mercator.
 *
 *  Water level / invert / relief come live from the world recipe as shader
 *  uniforms, so dragging a slider is instant with no re-fetch.
 * ------------------------------------------------------------------ */

import {
  TILE, MAX_TILE_Z, FRAG, clamp,
  lonToWX, latToWY,
  linkProgram, createTileCache,
} from "../terrain.js";

// Subdivisions per tile edge. A tile is drawn as GRID_N×GRID_N cells so that on
// the globe `projectTile` resolves the curvature smoothly instead of chording
// across it. Cheap (a few k triangles per visible tile) and harmless on mercator
// where the extra vertices just sit on a flat plane.
const GRID_N = 16;

// Below this zoom the globe is a disc smaller than the viewport, so its corners
// unproject to empty space (or the silhouette) and miss the visible polar bulge
// — screen-corner tile selection would leave gaps. So while zoomed out we draw
// the WHOLE sphere instead; the back hemisphere is clipped by projectTile's
// clipping-plane z and the front is fully covered. From ~this zoom up the globe
// fills the viewport, its corners land on real map points, and the tight
// visible-AABB walk is both reliable and far sharper.
//
// (Note: MapLibre keeps projectionTransition at 1 across this whole range — the
// view only *looks* flat when zoomed into a small patch of the sphere — so the
// switch is keyed on zoom, not on the transition value.)
const GLOBE_FULL_ZOOM = 4;
// When drawing the whole sphere, cap the tile zoom so the full grid stays a few
// hundred tiles, not thousands. Below GLOBE_FULL_ZOOM the natural tile zoom is
// already ≤ this, so the cap only bites in the brief switch-over band.
const GLOBE_FULL_MAX_Z = 4;
// Pad the visible AABB by this fraction of its span on each side, so the slight
// globe bulge near the viewport edges (the sphere shows a hair more than the
// flat corner rectangle) never leaves a thin gap.
const VISIBLE_PAD = 0.12;

// Vertex body appended after the injected projection prelude + defines. `a_uv`
// runs 0..1 across the tile grid; we map it into the tile's mercator rectangle
// and hand that to MapLibre's `projectTile`, which is what makes one shader work
// under both projections. `uUv` lets a quad sample a sub-rectangle of an ancestor
// texture (fallback while a child tile streams in).
const VERT_BODY = `
in vec2 a_uv;
uniform vec4 uRectMerc; // x0, y0, sizeX, sizeY  (mercator 0..1)
uniform vec4 uUv;       // uvOffset.xy, uvScale.zw
out vec2 vUv;
void main() {
  vec2 merc = uRectMerc.xy + a_uv * uRectMerc.zw;
  vUv = uUv.xy + a_uv * uUv.zw;
  gl_Position = projectTile(merc);
}`;

// A non-indexed triangle list over an n×n grid of the unit square. Returns the
// Float32Array of [x,y] pairs; vertex count is n*n*6.
function buildGrid(n) {
  const v = [];
  const step = 1 / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = i * step, y0 = j * step, x1 = x0 + step, y1 = y0 + step;
      v.push(x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1);
    }
  }
  return new Float32Array(v);
}

/**
 * Build the terrain custom layer.
 * @param {object} recipe  live world recipe; reads `recipe.world.{invert,water,relief}`
 * @returns {import("maplibre-gl").CustomLayerInterface}
 */
export function createTerrainLayer(recipe) {
  let map = null;
  let gl = null;
  let grid = null;          // GL buffer for the tessellated unit grid
  let gridCount = 0;        // vertices in the grid
  let tiles = null;

  // One compiled program per projection variant (mercator vs globe). The prelude
  // — and thus the correct projectTile — changes with the projection, so we key
  // the cache on shaderData.variantName and build lazily on first sight.
  const programs = new Map(); // variantName -> { program, aUv, U }

  function uniforms() {
    return {
      invert: recipe.world.invert ? 1 : 0,
      sea: recipe.world.water,
      relief: recipe.world.relief,
    };
  }

  function getProgram(shaderData) {
    let entry = programs.get(shaderData.variantName);
    if (entry) return entry;

    const vert =
      `#version 300 es\n` +
      `${shaderData.vertexShaderPrelude}\n${shaderData.define}\n${VERT_BODY}`;
    const program = linkProgram(gl, vert, FRAG);

    entry = {
      program,
      aUv: gl.getAttribLocation(program, "a_uv"),
      U: {
        rect: gl.getUniformLocation(program, "uRectMerc"),
        uv: gl.getUniformLocation(program, "uUv"),
        tile: gl.getUniformLocation(program, "uTile"),
        invert: gl.getUniformLocation(program, "uInvert"),
        sea: gl.getUniformLocation(program, "uSea"),
        relief: gl.getUniformLocation(program, "uRelief"),
        texel: gl.getUniformLocation(program, "uTexel"),
        // Projection uniforms supplied by the injected prelude. Unused ones in a
        // given variant resolve to null, and gl.uniform* on null is a safe no-op.
        pMatrix: gl.getUniformLocation(program, "u_projection_matrix"),
        pTileMerc: gl.getUniformLocation(program, "u_projection_tile_mercator_coords"),
        pClip: gl.getUniformLocation(program, "u_projection_clipping_plane"),
        pTransition: gl.getUniformLocation(program, "u_projection_transition"),
        pFallback: gl.getUniformLocation(program, "u_projection_fallback_matrix"),
      },
    };
    programs.set(shaderData.variantName, entry);
    return entry;
  }

  // Feed MapLibre's projection uniforms to the current program so `projectTile`
  // resolves correctly. mainMatrix alone suffices for mercator; the rest drive
  // the globe and the globe⇄mercator morph.
  function setProjection(U, pd) {
    gl.uniformMatrix4fv(U.pMatrix, false, pd.mainMatrix);
    gl.uniform4f(U.pTileMerc, ...pd.tileMercatorCoords);
    gl.uniform4f(U.pClip, ...pd.clippingPlane);
    gl.uniform1f(U.pTransition, pd.projectionTransition);
    gl.uniformMatrix4fv(U.pFallback, false, pd.fallbackMatrix);
  }

  // Visible mercator AABB for the current camera (mercator / near-mercator only).
  // Unproject the four viewport corners, convert to mercator [0,1], and unwrap
  // each around the centre so a view straddling the antimeridian stays a
  // contiguous range (possibly outside [0,1] — the tile loop wraps it).
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

  function drawTile(U, x0, y0, sizeX, sizeY, t) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform4f(U.rect, x0, y0, sizeX, sizeY);
    gl.uniform4f(U.uv, t.ox || 0, t.oy || 0, t.s || 1, t.s || 1);
    gl.drawArrays(gl.TRIANGLES, 0, gridCount);
  }

  return {
    id: "inversia-terrain",
    type: "custom",
    renderingMode: "2d",

    onAdd(m, glCtx) {
      map = m;
      gl = glCtx;

      const verts = buildGrid(GRID_N);
      gridCount = verts.length / 2;
      grid = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, grid);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      // Repaint as tiles stream in — MapLibre only renders on demand.
      tiles = createTileCache(gl, () => map.triggerRepaint());
    },

    onRemove() {
      if (gl) {
        for (const { program } of programs.values()) gl.deleteProgram(program);
        if (grid) gl.deleteBuffer(grid);
      }
      programs.clear();
      grid = tiles = null;
    },

    render(_gl, args) {
      const pd = args.defaultProjectionData;
      const { program, aUv, U } = getProgram(args.shaderData);

      tiles.tick();

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, grid);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      setProjection(U, pd);

      const { invert, sea, relief } = uniforms();
      gl.uniform1i(U.tile, 0);
      gl.uniform2f(U.texel, 1 / TILE, 1 / TILE);
      gl.uniform1f(U.invert, invert);
      gl.uniform1f(U.sea, sea);
      gl.uniform1f(U.relief, relief);

      // Terrarium tiles are 256px; MapLibre zoom is defined on 512px tiles, so a
      // tile zoom of round(zoom)+1 keeps each tile ~256 CSS px on screen — the
      // same on-screen density the legacy slippy map rendered at.
      let Z = clamp(Math.round(map.getZoom()) + 1, 0, MAX_TILE_Z);

      // Choose the tile set. Zoomed out (globe smaller than the viewport),
      // corner unprojection can't be trusted, so cover the whole sphere at a
      // capped zoom — the back hemisphere is clipped by projectTile, the front is
      // fully painted. Once the globe fills the viewport, walk only the tight
      // (padded) visible AABB, which is reliable and much sharper.
      const globeFull = map.getZoom() < GLOBE_FULL_ZOOM;
      let txa, txb, tya, tyb;
      if (globeFull) {
        Z = Math.min(Z, GLOBE_FULL_MAX_Z);
        const n = 1 << Z;
        txa = 0; txb = n - 1; tya = 0; tyb = n - 1;
      } else {
        const n = 1 << Z;
        let { minX, maxX, minY, maxY } = visibleRange();
        const px = (maxX - minX) * VISIBLE_PAD, py = (maxY - minY) * VISIBLE_PAD;
        minX -= px; maxX += px; minY = clamp(minY - py, 0, 1); maxY = clamp(maxY + py, 0, 1);
        txa = Math.floor(minX * n); txb = Math.floor(maxX * n);
        tya = Math.max(0, Math.floor(minY * n));
        tyb = Math.min(n - 1, Math.floor(maxY * n));
      }
      const n = 1 << Z;

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
            drawTile(U, rawTx / n, ty / n, 1 / n, 1 / n, t);
          }
        }
      }

      if (wanted.length) {
        const cxw = (txa + txb + 1) / 2, cyw = (tya + tyb + 1) / 2;
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
