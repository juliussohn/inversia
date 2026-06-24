import "./style.css";
import { readHash, buildHash, navigateWithFade } from "./handoff.js";

/* ------------------------------------------------------------------ *
 *  Inversia — zoomable streaming map
 *
 *  A custom WebGL2 Web-Mercator slippy map that streams Terrarium elevation
 *  tiles (real topography + bathymetry, public domain) from AWS Terrain Tiles
 *  and renders Inversia live: each fragment decodes the tile's elevation,
 *  optionally inverts it, floods everything below the chosen water level, and
 *  colours it hypsometrically with hillshading. Water level and inversion are
 *  shader uniforms, so they update instantly with no re-fetching.
 *
 *  Tile elevation (Terrarium):  e = R*256 + G + B/256 - 32768   (metres)
 * ------------------------------------------------------------------ */

const TILE = 256;
const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MAX_TILE_Z = 15; // deepest tiles AWS serves
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 16.5; // allow a little overzoom past z15
const CACHE_LIMIT = 600;
const MAX_INFLIGHT = 8;

const $ = (id) => document.getElementById(id);

// ---- mercator helpers (world coords in 0..1) ----------------------------
const lonToWX = (lon) => (lon + 180) / 360;
const latToWY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const wxToLon = (x) => x * 360 - 180;
const wyToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- shaders (GLSL ES 3.00) ---------------------------------------------
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

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTile;
uniform float uInvert;   // 0 real, 1 inversia
uniform float uSea;      // water level, metres
uniform float uRelief;   // hillshade strength 0..2
uniform vec2 uTexel;     // 1/256
out vec4 o;

float decode(vec2 uv) {
  vec3 t = texture(uTile, uv).rgb * 255.0;
  return (t.r * 256.0 + t.g + t.b / 256.0) - 32768.0;
}

vec3 landColor(float h) {
  vec3 c = vec3(0.85, 0.78, 0.60);
  c = mix(c, vec3(0.30, 0.48, 0.24), smoothstep(0.0, 60.0, h));
  c = mix(c, vec3(0.42, 0.55, 0.26), smoothstep(60.0, 500.0, h));
  c = mix(c, vec3(0.60, 0.60, 0.28), smoothstep(500.0, 1100.0, h));
  c = mix(c, vec3(0.52, 0.40, 0.24), smoothstep(1100.0, 2000.0, h));
  c = mix(c, vec3(0.40, 0.31, 0.22), smoothstep(2000.0, 3000.0, h));
  c = mix(c, vec3(0.62, 0.60, 0.57), smoothstep(3000.0, 4200.0, h));
  c = mix(c, vec3(0.96, 0.97, 1.00), smoothstep(4200.0, 6500.0, h));
  return c;
}
vec3 seaColor(float d) {
  vec3 c = vec3(0.23, 0.62, 0.74);
  c = mix(c, vec3(0.16, 0.45, 0.69), smoothstep(0.0, 350.0, d));
  c = mix(c, vec3(0.12, 0.35, 0.59), smoothstep(350.0, 1800.0, d));
  c = mix(c, vec3(0.09, 0.25, 0.47), smoothstep(1800.0, 3800.0, d));
  c = mix(c, vec3(0.05, 0.14, 0.31), smoothstep(3800.0, 7000.0, d));
  return c;
}

void main() {
  float e = decode(vUv);
  float eff = mix(e, -e, uInvert);
  float above = eff - uSea;
  bool land = above > 0.0;
  vec3 base = land ? landColor(above) : seaColor(-above);

  // hillshade from local slope (sign follows inversion so relief reads right)
  float sgn = mix(1.0, -1.0, uInvert);
  float dzdx = (decode(vUv + vec2(uTexel.x, 0.0)) - decode(vUv - vec2(uTexel.x, 0.0))) * sgn;
  float dzdy = (decode(vUv + vec2(0.0, uTexel.y)) - decode(vUv - vec2(0.0, uTexel.y))) * sgn;
  vec3 normal = normalize(vec3(-dzdx * uRelief, -dzdy * uRelief, 220.0));
  vec3 lightDir = normalize(vec3(-0.9, -1.0, 1.3));
  float diff = clamp(dot(normal, lightDir) * 0.5 + 0.55, 0.15, 1.15);
  vec3 col = base * diff;

  col = pow(clamp(col, 0.0, 1.0), vec3(0.92));
  o = vec4(col, 1.0);
}`;

// ---- GL setup -----------------------------------------------------------
const canvas = $("map");
const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (!gl) {
  fail("Your browser/WebGL2 can't run the map. Try the Globe view.");
  throw new Error("no webgl2");
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}
const program = gl.createProgram();
try {
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) || "link failed");
} catch (err) {
  fail("Couldn't initialise the map renderer. Try the Globe view.");
  throw err;
}
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

// ---- state --------------------------------------------------------------
const params = { invert: 1, sea: 0, relief: 1.0 };
const view = { wx: 0.5, wy: 0.5, zoom: 1.4 };
let W = 0, H = 0, dpr = 1;
let frameId = 0;
let lastT = 0;

// Smooth, momentum-style zoom: wheel/buttons nudge a target the view eases to.
let zoomTarget = view.zoom;     // where we're gliding toward
let zoomAnchor = null;          // screen px the zoom pivots around (cursor)

// ---- tile cache + loader ------------------------------------------------
const cache = new Map(); // key -> { tex, lastUsed }
let inflight = 0;

function texFromImage(img) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
  // NEAREST: never blend the packed elevation bytes (linear would corrupt them)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function requestTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return;
  if (inflight >= MAX_INFLIGHT) return;
  cache.set(key, { tex: null, lastUsed: frameId }); // reserve (avoid dup requests)
  inflight++;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    inflight--;
    const e = cache.get(key);
    if (e) e.tex = texFromImage(img);
  };
  img.onerror = () => {
    inflight--;
    cache.delete(key); // allow retry later
  };
  img.src = TILE_URL(z, x, y);
}

function ancestorTex(z, x, y) {
  for (let k = 1; k <= z; k++) {
    const pz = z - k, f = 1 << k;
    const px = Math.floor(x / f), py = Math.floor(y / f);
    const e = cache.get(`${pz}/${px}/${py}`);
    if (e && e.tex) {
      const s = 1 / f;
      return { tex: e.tex, ox: x * s - px, oy: y * s - py, s };
    }
  }
  return null;
}

function evict() {
  if (cache.size <= CACHE_LIMIT) return;
  const entries = [...cache.entries()].filter((e) => e[1].tex);
  entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (let i = 0; i < entries.length && cache.size > CACHE_LIMIT * 0.85; i++) {
    gl.deleteTexture(entries[i][1].tex);
    cache.delete(entries[i][0]);
  }
}

// ---- render -------------------------------------------------------------
function drawTile(sx, sy, size, t) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.uniform4f(U.rect, sx, sy, size, 0);
  gl.uniform4f(U.uv, t.ox || 0, t.oy || 0, t.s || 1, t.s || 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

let firstPaint = false;

// Ease the live zoom toward its target each frame (frame-rate independent),
// keeping the anchor point fixed under the cursor — this is what gives the
// glide/momentum feel after the trackpad stops moving.
function easeZoom(dt) {
  if (zoomAnchor === null) return;
  const diff = zoomTarget - view.zoom;
  if (Math.abs(diff) < 0.0006) {
    if (view.zoom !== zoomTarget) zoomAround(zoomAnchor.x, zoomAnchor.y, zoomTarget);
    zoomAnchor = null;
    return;
  }
  const k = 1 - Math.exp(-dt * 13); // higher = snappier, lower = floatier
  zoomAround(zoomAnchor.x, zoomAnchor.y, view.zoom + diff * k);
}

function frame(now) {
  frameId++;
  const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 0.016;
  lastT = now;
  stepFly(dt);
  easeZoom(dt);

  gl.viewport(0, 0, canvas.width, canvas.height);
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
  let loadedCount = 0, total = 0;
  for (let ty = tya; ty <= tyb; ty++) {
    for (let rawTx = txa; rawTx <= txb; rawTx++) {
      total++;
      const dx = ((rawTx % n) + n) % n;
      const key = `${Z}/${dx}/${ty}`;
      const e = cache.get(key);
      let t = null;
      if (e && e.tex) {
        e.lastUsed = frameId;
        t = { tex: e.tex, ox: 0, oy: 0, s: 1 };
        loadedCount++;
      } else {
        t = ancestorTex(Z, dx, ty);
        wanted.push([dx, ty, rawTx]);
      }
      if (t) {
        const sx = (rawTx / n - view.wx) * worldPx + W / 2;
        const sy = (ty / n - view.wy) * worldPx + H / 2;
        drawTile(sx, sy, tilePx, t);
      }
    }
  }

  // request missing tiles, nearest-to-centre first
  if (wanted.length) {
    const cxw = view.wx * n, cyw = view.wy * n;
    wanted.sort(
      (a, b) =>
        (a[0] - cxw) ** 2 + (a[1] - cyw) ** 2 - ((b[0] - cxw) ** 2 + (b[1] - cyw) ** 2),
    );
    for (const [dx, ty] of wanted) requestTile(Z, dx, ty);
  }
  evict();

  if (!firstPaint && total > 0 && loadedCount === total) {
    firstPaint = true;
    $("loader").classList.add("hidden");
  }

  updateMeDot(worldPx);
  requestAnimationFrame(frame);
}

const meDotEl = $("me-dot");
function updateMeDot(worldPx) {
  if (!meMarker) return;
  // account for the world wrapping horizontally; pick the nearest copy
  let dx = meMarker.wx - view.wx;
  dx = ((dx % 1) + 1.5) % 1 - 0.5;
  const sx = dx * worldPx + W / 2;
  const sy = (meMarker.wy - view.wy) * worldPx + H / 2;
  const onScreen = sx >= -20 && sx <= W + 20 && sy >= -20 && sy <= H + 20;
  meDotEl.classList.toggle("show", onScreen);
  if (onScreen) meDotEl.style.transform = `translate(${sx}px, ${sy}px)`;
}

// ---- interaction --------------------------------------------------------
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
  updateReadout();
}

const pointers = new Map();
let pinchPrev = null;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchPrev = null;
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const prev = { x: p.x, y: p.y };
  p.x = e.clientX;
  p.y = e.clientY;

  if (pointers.size === 1) {
    const worldPx = TILE * Math.pow(2, view.zoom);
    view.wx -= (p.x - prev.x) / worldPx;
    view.wy -= (p.y - prev.y) / worldPx;
    clampView();
    updateReadout();
  } else if (pointers.size >= 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (pinchPrev) {
      if (pinchPrev.dist > 0) {
        zoomAround(mid.x, mid.y, view.zoom + Math.log2(dist / pinchPrev.dist));
        zoomTarget = view.zoom; // direct manipulation wins; keep target in sync
        zoomAnchor = null;
      }
      const worldPx = TILE * Math.pow(2, view.zoom);
      view.wx -= (mid.x - pinchPrev.x) / worldPx;
      view.wy -= (mid.y - pinchPrev.y) / worldPx;
      clampView();
    }
    pinchPrev = { dist, x: mid.x, y: mid.y };
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchPrev = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  // Normalise across devices: trackpads report pixels, mice report lines/pages.
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;      // lines → px
  else if (e.deltaMode === 2) d *= H;  // pages → px
  // Pinch-zoom gestures arrive as ctrl+wheel with small deltas — zoom faster.
  const factor = e.ctrlKey ? 0.012 : 0.0022;
  zoomTarget = clamp(zoomTarget - d * factor, MIN_ZOOM, MAX_ZOOM);
  zoomAnchor = { x: e.clientX, y: e.clientY };
  if (d > 0) maybeGoGlobe(); // zooming out past the world → fly up to the globe
}, { passive: false });

// ---- UI -----------------------------------------------------------------
function updateReadout() {
  const lat = wyToLat(view.wy).toFixed(2);
  const lon = wxToLon(view.wx).toFixed(2);
  $("readout").textContent = `z${view.zoom.toFixed(1)} · ${lat}, ${lon}`;
}

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}
window.addEventListener("resize", resize);

function bindUI() {
  const sea = $("sea"), seaV = $("sea-value");
  const relief = $("relief"), reliefV = $("relief-value");
  const modeBtn = $("mode-toggle"), modeV = $("mode-value");
  const uiToggle = $("ui-toggle");

  function setMode() {
    modeV.textContent = params.invert ? "Inversia" : "Real Earth";
    refreshStats();
  }
  sea.addEventListener("input", () => {
    params.sea = +sea.value;
    seaV.textContent = `${params.sea > 0 ? "+" : ""}${params.sea} m`;
    refreshStats();
  });
  relief.addEventListener("input", () => {
    params.relief = +relief.value / 100;
    reliefV.textContent = `${relief.value}%`;
  });
  modeBtn.addEventListener("click", () => {
    params.invert = params.invert ? 0 : 1;
    setMode();
  });
  uiToggle.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("ui-hidden");
    uiToggle.title = hidden ? "Show controls" : "Hide controls";
  });
  const nudgeZoom = (delta) => {
    zoomTarget = clamp(zoomTarget + delta, MIN_ZOOM, MAX_ZOOM);
    zoomAnchor = { x: W / 2, y: H / 2 };
    if (delta < 0) maybeGoGlobe();
  };
  $("zoom-in").addEventListener("click", () => nudgeZoom(1));
  $("zoom-out").addEventListener("click", () => nudgeZoom(-1));
  $("globe-link").addEventListener("click", (e) => {
    e.preventDefault();
    navigateWithFade("globe.html" + buildHash({
      lat: wyToLat(view.wy), lon: wxToLon(view.wx),
      invert: !!params.invert, sea: params.sea,
    }));
  });
  $("reset-view").addEventListener("click", () => {
    view.wx = 0.5;
    view.wy = 0.5;
    view.zoom = Math.max(MIN_ZOOM, Math.log2(Math.min(W, H) / TILE) - 0.05);
    zoomTarget = view.zoom;
    zoomAnchor = null;
    clampView();
    updateReadout();
  });
  bindLocate();
  setMode();
}

// ---- fly-to (smooth glide to a world point + zoom) ----------------------
let flying = null; // { sx, sy, sz, tx, ty, tz, t } animation state
function flyTo(wx, wy, zoom) {
  zoomAnchor = null; // hand control to the fly animation
  // shortest path across the antimeridian seam
  let tx = ((wx % 1) + 1) % 1;
  const sx = view.wx;
  if (tx - sx > 0.5) tx -= 1;
  else if (sx - tx > 0.5) tx += 1;
  flying = { sx, sy: view.wy, sz: view.zoom, tx, ty: wy, tz: clamp(zoom, MIN_ZOOM, MAX_ZOOM), t: 0 };
}
function stepFly(dt) {
  if (!flying) return;
  flying.t = Math.min(1, flying.t + dt / 0.9); // ~0.9s glide
  const e = flying.t < 0.5 ? 4 * flying.t ** 3 : 1 - Math.pow(-2 * flying.t + 2, 3) / 2; // easeInOutCubic
  view.wx = flying.sx + (flying.tx - flying.sx) * e;
  view.wy = flying.sy + (flying.ty - flying.sy) * e;
  view.zoom = flying.sz + (flying.tz - flying.sz) * e;
  clampView();
  updateReadout();
  if (flying.t >= 1) {
    zoomTarget = view.zoom;
    flying = null;
  }
}

// ---- geolocation ("go to my location") ----------------------------------
let meMarker = null; // { wx, wy } in world coords, drawn as a dot
function bindLocate() {
  const btn = $("locate");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      btn.classList.add("error");
      btn.title = "Geolocation not supported";
      return;
    }
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("busy");
        btn.classList.add("active");
        const wx = lonToWX(pos.coords.longitude);
        const wy = latToWY(pos.coords.latitude);
        meMarker = { wx, wy };
        flyTo(wx, wy, Math.min(MAX_ZOOM, 12));
      },
      () => {
        btn.classList.remove("busy");
        btn.title = "Couldn't get your location";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

// ---- global land/ocean stat (decoded from the z0 world tile) ------------
let worldGrid = null;
function loadWorldStat() {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = TILE;
    c.height = TILE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    const elev = new Float32Array(TILE * TILE);
    const wgt = new Float32Array(TILE * TILE);
    for (let y = 0; y < TILE; y++) {
      const lat = wyToLat((y + 0.5) / TILE);
      const cl = Math.cos((lat * Math.PI) / 180);
      const w = cl * cl; // geographic area per mercator pixel ∝ cos²(lat)
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x, p = i * 4;
        elev[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
        wgt[i] = w;
      }
    }
    worldGrid = { elev, wgt };
    refreshStats();
  };
  img.src = TILE_URL(0, 0, 0);
}
function refreshStats() {
  if (!worldGrid) return;
  let land = 0, tot = 0;
  const { elev, wgt } = worldGrid;
  for (let i = 0; i < elev.length; i++) {
    let e = params.invert ? -elev[i] : elev[i];
    if (e - params.sea > 0) land += wgt[i];
    tot += wgt[i];
  }
  const lf = land / tot;
  $("land-pct").textContent = `${(lf * 100).toFixed(1)}%`;
  $("sea-pct").textContent = `${((1 - lf) * 100).toFixed(1)}%`;
}

function fail(msg) {
  const l = $("loader");
  if (l) {
    l.classList.add("error");
    $("loader-text").textContent = msg;
  }
}

// ---- cross-view handoff (map → globe) -----------------------------------
// Zooming out past the point where the whole world fits flies up to the
// globe, centred on wherever you were looking.
let handoffReady = false;
function maybeGoGlobe() {
  if (!handoffReady) return false;
  const fit = Math.max(MIN_ZOOM, Math.log2(Math.min(W, H) / TILE) - 0.05);
  const GLOBE_AT = Math.max(MIN_ZOOM + 0.25, fit - 0.8);
  if (zoomTarget > GLOBE_AT) return false;
  const lat = wyToLat(view.wy), lon = wxToLon(view.wx);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  navigateWithFade("globe.html" + buildHash({
    lat, lon, invert: !!params.invert, sea: params.sea,
  }));
  return true;
}

// Restore state handed in from the globe (or a shared link).
function applyHashState() {
  const s = readHash();
  if (s.sea != null) {
    const seaEl = $("sea");
    seaEl.value = clamp(s.sea, +seaEl.min, +seaEl.max);
    seaEl.dispatchEvent(new Event("input"));
  }
  if (s.invert != null && params.invert !== (s.invert ? 1 : 0)) $("mode-toggle").click();
  if (s.lat != null && s.lon != null) {
    view.wx = lonToWX(s.lon);
    view.wy = clamp(latToWY(s.lat), 0, 1);
  }
  if (s.zoom != null) view.zoom = clamp(s.zoom, MIN_ZOOM, MAX_ZOOM);
  zoomTarget = view.zoom;
  zoomAnchor = null;
  clampView();
  updateReadout();
}

// ---- go -----------------------------------------------------------------
resize();
view.zoom = Math.max(MIN_ZOOM, Math.log2(Math.min(W, H) / TILE) - 0.05);
zoomTarget = view.zoom;
bindUI();
applyHashState();
loadWorldStat();
requestAnimationFrame(frame);
setTimeout(() => { handoffReady = true; }, 500);
// Safety net: never leave the loader spinning forever if a few tiles stall.
setTimeout(() => $("loader").classList.add("hidden"), 6000);
