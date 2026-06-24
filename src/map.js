import {
  TILE, MAX_TILE_Z, FRAG, clamp,
  lonToWX, latToWY, wxToLon, wyToLat,
  linkProgram, createTileCache,
} from "./terrain.js";

/* ------------------------------------------------------------------ *
 *  Inversia — zoomable streaming map (flat Web-Mercator presentation)
 *
 *  A custom WebGL2 slippy map that streams Terrarium elevation tiles and
 *  renders them with the SHARED terrain shader (see terrain.js). Water level,
 *  inversion and relief are shader uniforms read live from the shared `params`
 *  object, so they update instantly with no re-fetching — and stay in lock-step
 *  with the globe presentation.
 *
 *  Exposed as a factory so the orchestrator (app.js) can mount it on a canvas,
 *  share state with the globe, and crossfade between the two.
 * ------------------------------------------------------------------ */

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 16.5; // allow a little overzoom past z15

const VERT = `#version 300 es
in vec2 a_uv;
uniform vec4 uRect;   // x, y (top-left, CSS px), z = size (square, px)
uniform vec2 uRes;    // canvas CSS size
uniform vec4 uUv;     // uvOffset.xy, uvScale.zw  (for ancestor fallback)
out vec2 vUv;
void main() {
  vec2 px = uRect.xy + a_uv * uRect.z;
  vec2 clip = vec2(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0);
  vUv = uUv.xy + a_uv * uUv.zw;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

// Mount the flat-map renderer on `canvas`, reading live from shared `params`
// ({ invert, sea, relief }). hooks: { onZoomOut(geo), onReadout(text) }.
export function createMapView(canvas, params, hooks = {}) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) throw new Error("no webgl2");

  const program = linkProgram(gl, VERT, FRAG);
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  const aUv = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

  const U = {
    rect: gl.getUniformLocation(program, "uRect"),
    res: gl.getUniformLocation(program, "uRes"),
    uv: gl.getUniformLocation(program, "uUv"),
    tile: gl.getUniformLocation(program, "uTile"),
    invert: gl.getUniformLocation(program, "uInvert"),
    sea: gl.getUniformLocation(program, "uSea"),
    relief: gl.getUniformLocation(program, "uRelief"),
    texel: gl.getUniformLocation(program, "uTexel"),
  };
  gl.uniform1i(U.tile, 0);
  gl.uniform2f(U.texel, 1 / TILE, 1 / TILE);

  // ---- state ------------------------------------------------------------
  const view = { wx: 0.5, wy: 0.5, zoom: 1.4 };
  let W = 0, H = 0, dpr = 1;
  let running = false, rafId = 0, lastT = 0;

  // Smooth, momentum-style zoom: wheel/buttons nudge a target the view eases to.
  let zoomTarget = view.zoom;
  let zoomAnchor = null;

  const tiles = createTileCache(gl);

  // ---- render -----------------------------------------------------------
  function drawTile(sx, sy, size, t) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform4f(U.rect, sx, sy, size, 0);
    gl.uniform4f(U.uv, t.ox || 0, t.oy || 0, t.s || 1, t.s || 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Ease the live zoom toward its target each frame (frame-rate independent),
  // keeping the anchor point fixed under the cursor — the glide/momentum feel.
  function easeZoom(dt) {
    if (zoomAnchor === null) return;
    const diff = zoomTarget - view.zoom;
    if (Math.abs(diff) < 0.0006) {
      if (view.zoom !== zoomTarget) zoomAround(zoomAnchor.x, zoomAnchor.y, zoomTarget);
      zoomAnchor = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 13);
    zoomAround(zoomAnchor.x, zoomAnchor.y, view.zoom + diff * k);
  }

  function frame(now) {
    if (!running) return;
    tiles.tick();
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 0.016;
    lastT = now;
    stepFly(dt);
    easeZoom(dt);

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(U.res, W, H);
    gl.uniform1f(U.invert, params.invert);
    gl.uniform1f(U.sea, params.sea);
    gl.uniform1f(U.relief, params.relief);

    const Z = clamp(Math.round(view.zoom), 0, MAX_TILE_Z);
    const n = 1 << Z;
    const worldPx = TILE * Math.pow(2, view.zoom);
    const tilePx = worldPx / n;

    const x0 = view.wx - W / 2 / worldPx, x1 = view.wx + W / 2 / worldPx;
    const y0 = view.wy - H / 2 / worldPx, y1 = view.wy + H / 2 / worldPx;
    const txa = Math.floor(x0 * n), txb = Math.floor(x1 * n);
    const tya = Math.max(0, Math.floor(y0 * n)), tyb = Math.min(n - 1, Math.floor(y1 * n));

    const wanted = [];
    for (let ty = tya; ty <= tyb; ty++) {
      for (let rawTx = txa; rawTx <= txb; rawTx++) {
        const dx = ((rawTx % n) + n) % n;
        const key = `${Z}/${dx}/${ty}`;
        const e = tiles.get(key);
        let t = null;
        if (e && e.tex) {
          tiles.touch(e);
          t = { tex: e.tex, ox: 0, oy: 0, s: 1 };
        } else {
          t = tiles.ancestor(Z, dx, ty);
          wanted.push([dx, ty, rawTx]);
        }
        if (t) {
          const sx = (rawTx / n - view.wx) * worldPx + W / 2;
          const sy = (ty / n - view.wy) * worldPx + H / 2;
          drawTile(sx, sy, tilePx, t);
        }
      }
    }

    if (wanted.length) {
      const cxw = view.wx * n, cyw = view.wy * n;
      wanted.sort(
        (a, b) => (a[0] - cxw) ** 2 + (a[1] - cyw) ** 2 - ((b[0] - cxw) ** 2 + (b[1] - cyw) ** 2),
      );
      for (const [dx, ty] of wanted) tiles.request(Z, dx, ty);
    }
    tiles.evict();

    updateMeDot(worldPx);
    rafId = requestAnimationFrame(frame);
  }

  // ---- "my location" dot (managed by app via setMeMarker) ---------------
  let meMarker = null;
  let meDotEl = null;
  function updateMeDot(worldPx) {
    if (!meDotEl) return;
    if (!meMarker) { meDotEl.classList.remove("show"); return; }
    let dx = meMarker.wx - view.wx;
    dx = ((dx % 1) + 1.5) % 1 - 0.5;
    const sx = dx * worldPx + W / 2;
    const sy = (meMarker.wy - view.wy) * worldPx + H / 2;
    const onScreen = sx >= -20 && sx <= W + 20 && sy >= -20 && sy <= H + 20;
    meDotEl.classList.toggle("show", onScreen);
    if (onScreen) meDotEl.style.transform = `translate(${sx}px, ${sy}px)`;
  }

  // ---- interaction ------------------------------------------------------
  function screenToWorld(px, py) {
    const worldPx = TILE * Math.pow(2, view.zoom);
    return { wx: view.wx + (px - W / 2) / worldPx, wy: view.wy + (py - H / 2) / worldPx };
  }
  function clampView() {
    view.zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
    view.wy = clamp(view.wy, 0, 1);
    view.wx = ((view.wx % 1) + 1) % 1;
  }
  function zoomAround(px, py, nz) {
    const before = screenToWorld(px, py);
    view.zoom = clamp(nz, MIN_ZOOM, MAX_ZOOM);
    const after = screenToWorld(px, py);
    view.wx += before.wx - after.wx;
    view.wy += before.wy - after.wy;
    clampView();
    emitReadout();
  }

  const pointers = new Map();
  let pinchPrev = null;

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchPrev = null;
  }
  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const prev = { x: p.x, y: p.y };
    p.x = e.clientX; p.y = e.clientY;

    if (pointers.size === 1) {
      const worldPx = TILE * Math.pow(2, view.zoom);
      view.wx -= (p.x - prev.x) / worldPx;
      view.wy -= (p.y - prev.y) / worldPx;
      clampView();
      emitReadout();
    } else if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (pinchPrev) {
        if (pinchPrev.dist > 0) {
          zoomAround(mid.x, mid.y, view.zoom + Math.log2(dist / pinchPrev.dist));
          zoomTarget = view.zoom;
          zoomAnchor = null;
        }
        const worldPx = TILE * Math.pow(2, view.zoom);
        view.wx -= (mid.x - pinchPrev.x) / worldPx;
        view.wy -= (mid.y - pinchPrev.y) / worldPx;
        clampView();
      }
      pinchPrev = { dist, x: mid.x, y: mid.y };
      maybeZoomOut();
    }
  }
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
  }
  function onWheel(e) {
    e.preventDefault();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;      // lines → px
    else if (e.deltaMode === 2) d *= H;  // pages → px
    const factor = e.ctrlKey ? 0.012 : 0.0022;
    zoomTarget = clamp(zoomTarget - d * factor, MIN_ZOOM, MAX_ZOOM);
    zoomAnchor = { x: e.clientX, y: e.clientY };
    if (d > 0) maybeZoomOut();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // ---- fly-to (smooth glide to a world point + zoom) --------------------
  let flying = null;
  function flyTo(wx, wy, zoom) {
    zoomAnchor = null;
    let tx = ((wx % 1) + 1) % 1;
    const sx = view.wx;
    if (tx - sx > 0.5) tx -= 1;
    else if (sx - tx > 0.5) tx += 1;
    flying = { sx, sy: view.wy, sz: view.zoom, tx, ty: wy, tz: clamp(zoom, MIN_ZOOM, MAX_ZOOM), t: 0 };
  }
  function stepFly(dt) {
    if (!flying) return;
    flying.t = Math.min(1, flying.t + dt / 0.9);
    const e = flying.t < 0.5 ? 4 * flying.t ** 3 : 1 - Math.pow(-2 * flying.t + 2, 3) / 2;
    view.wx = flying.sx + (flying.tx - flying.sx) * e;
    view.wy = flying.sy + (flying.ty - flying.sy) * e;
    view.zoom = flying.sz + (flying.tz - flying.sz) * e;
    clampView();
    emitReadout();
    if (flying.t >= 1) { zoomTarget = view.zoom; flying = null; }
  }

  // ---- zoom-out → hand off to the globe ---------------------------------
  // Both presentations cross over at the same detail level (hooks.switchZoom):
  // zoom out below it and we fly up to the globe, centred on the view, so the
  // globe and map show matching detail at the swap and you don't notice it.
  function fitZoom() { return Math.max(MIN_ZOOM, Math.log2(Math.min(W, H) / TILE) - 0.05); }
  const SWITCH = hooks.switchZoom ?? 6;
  let active = false;
  function maybeZoomOut() {
    if (!active || !hooks.onZoomOut) return;
    if (zoomTarget >= SWITCH) return;
    const lat = wyToLat(view.wy), lon = wxToLon(view.wx);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    // hand off the zoom we're heading to (already below the crossover), so the
    // globe opens just under it and won't bounce straight back
    hooks.onZoomOut({ lat, lon, zoom: zoomTarget });
  }

  function emitReadout() {
    if (hooks.onReadout) hooks.onReadout(`z${view.zoom.toFixed(1)} · ${wyToLat(view.wy).toFixed(2)}, ${wxToLon(view.wx).toFixed(2)}`);
  }

  // ---- sizing -----------------------------------------------------------
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  resize();
  window.addEventListener("resize", resize);
  // initial zoom: fit the world to the smaller screen dimension
  view.zoom = fitZoom();
  zoomTarget = view.zoom;
  emitReadout();

  // ---- public handle ----------------------------------------------------
  return {
    canvas,
    start() { if (!running) { running = true; lastT = 0; active = true; rafId = requestAnimationFrame(frame); } },
    stop() { running = false; active = false; cancelAnimationFrame(rafId); },
    setActive(on) { active = on; },
    getGeo() { return { lat: wyToLat(view.wy), lon: wxToLon(view.wx), zoom: view.zoom }; },
    setGeo({ lat, lon, zoom }) {
      if (lon != null) view.wx = lonToWX(lon);
      if (lat != null) view.wy = clamp(latToWY(lat), 0, 1);
      if (zoom != null) view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      zoomTarget = view.zoom;
      zoomAnchor = null;
      flying = null;
      clampView();
      emitReadout();
    },
    zoomBy(delta) {
      zoomTarget = clamp(zoomTarget + delta, MIN_ZOOM, MAX_ZOOM);
      zoomAnchor = { x: W / 2, y: H / 2 };
      if (delta < 0) maybeZoomOut();
    },
    reset() {
      view.wx = 0.5; view.wy = 0.5; view.zoom = fitZoom();
      zoomTarget = view.zoom; zoomAnchor = null; flying = null;
      clampView(); emitReadout();
    },
    flyToLatLon(lat, lon, zoom) { flyTo(lonToWX(lon), latToWY(lat), zoom); },
    setMeMarker(lat, lon) { meMarker = { wx: lonToWX(lon), wy: latToWY(lat) }; },
    bindMeDot(el) { meDotEl = el; },
  };
}
