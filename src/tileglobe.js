import "./style.css";
import { readHash, buildHash, navigateWithFade } from "./handoff.js";

/* ------------------------------------------------------------------ *
 *  Inversia — streaming tiled globe
 *
 *  The SAME Web-Mercator elevation tiles the flat map streams (AWS Terrain
 *  Tiles, Terrarium), wrapped onto a sphere. Each visible tile is drawn as a
 *  curved patch: a grid whose vertices are placed on the globe from the tile's
 *  lon/lat extent, textured and coloured by the exact same fragment shader as
 *  the flat map — so diving from the globe into the map is continuous (same
 *  data, same colours, just a flatter camera).
 *
 *  Tile elevation (Terrarium):  e = R*256 + G + B/256 - 32768   (metres)
 * ------------------------------------------------------------------ */

const TILE = 256;
const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MAX_TILE_Z = 15;
const CACHE_LIMIT = 600;
const MAX_INFLIGHT = 8;
const GRID = 12; // patch subdivision (GRID×GRID quads per tile)
const R = 1.0; // globe radius
const MIN_DIST = 1.025; // closest the camera comes to the surface
const MAX_DIST = 7.0;
const MERC_LAT = 85.0511; // Web-Mercator latitude limit

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- mercator helpers (world coords in 0..1) ----------------------------
const lonToWX = (lon) => (lon + 180) / 360;
const latToWY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const wxToLon = (x) => x * 360 - 180;
const wyToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

// world (mercator 0..1) → unit sphere position
function sphere(wx, wy) {
  const lon = (wx * 360 - 180) * (Math.PI / 180);
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy)));
  const cl = Math.cos(lat);
  return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}
// lon/lat (deg) → unit sphere direction
function dirOf(lon, lat) {
  const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180, cl = Math.cos(b);
  return [cl * Math.sin(a), Math.sin(b), cl * Math.cos(a)];
}

// ---- tiny mat4 (column-major) -------------------------------------------
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function lookAt(eye, ctr, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const z = nrm(sub(eye, ctr));
  const x = nrm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
  return o;
}

// ---- shaders ------------------------------------------------------------
const VERT = `#version 300 es
in vec2 a_uv;            // grid coord 0..1 within the tile
uniform vec4 uRect;      // wx0, wy0, size (mercator 0..1), unused
uniform vec4 uUv;        // uvOffset.xy, uvScale.zw (ancestor fallback)
uniform mat4 uViewProj;
uniform float uPole;     // bit1: extend top edge to N pole, bit2: bottom to S
out vec2 vUv;
const float PI = 3.141592653589793;
void main() {
  float wx = uRect.x + a_uv.x * uRect.z;
  float wy = uRect.y + a_uv.y * uRect.z;
  // Web-Mercator stops at ±85°, leaving a polar gap. For the top/bottom tile
  // rows, snap the outer grid edge up to the pole so the cap is filled with
  // the (clamped) edge data instead of a hole.
  if (mod(uPole, 2.0) >= 1.0 && a_uv.y == 0.0) wy = -2.0;
  else if (uPole >= 2.0 && a_uv.y == 1.0) wy = 3.0;
  float lon = wx * 2.0 * PI - PI;
  float lat = atan(sinh(PI * (1.0 - 2.0 * wy)));
  float cl = cos(lat);
  vec3 p = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
  vUv = uUv.xy + a_uv * uUv.zw;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

// Fragment stage is identical in spirit to the flat map: decode elevation,
// optionally invert, flood below the water level, colour hypsometrically and
// hillshade from local slope — so the globe and map look like one world.
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTile;
uniform float uInvert;
uniform float uSea;
uniform float uRelief;
uniform vec2 uTexel;
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

// thin atmosphere rim (drawn behind the globe as an additive backside shell)
const ATMO_VERT = `#version 300 es
in vec3 a_pos;
uniform mat4 uViewProj;
uniform vec3 uCam;
out vec3 vN; out vec3 vP;
void main() { vN = normalize(a_pos); vP = a_pos; gl_Position = uViewProj * vec4(a_pos, 1.0); }`;
const ATMO_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP;
uniform vec3 uCam;
out vec4 o;
void main() {
  vec3 V = normalize(uCam - vP);
  float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 4.0);
  o = vec4(vec3(0.30, 0.55, 1.0) * rim, rim);
}`;

// ---- GL setup -----------------------------------------------------------
const canvas = document.createElement("canvas");
canvas.id = "globe-canvas";
$("app").appendChild(canvas);
const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (!gl) { fail("Your browser/WebGL2 can't run the globe."); throw new Error("no webgl2"); }

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}
function link(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) || "link failed");
  return p;
}

let program, atmoProg;
try {
  program = link(VERT, FRAG);
  atmoProg = link(ATMO_VERT, ATMO_FRAG);
} catch (err) {
  fail("Couldn't initialise the globe renderer.");
  throw err;
}

// ---- patch grid geometry (shared by every tile) -------------------------
const gridVerts = [];
for (let j = 0; j <= GRID; j++)
  for (let i = 0; i <= GRID; i++) gridVerts.push(i / GRID, j / GRID);
const gridIdx = [];
for (let j = 0; j < GRID; j++)
  for (let i = 0; i < GRID; i++) {
    const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
    gridIdx.push(a, b, c, b, d, c);
  }
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const gridVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, gridVBO);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVerts), gl.STATIC_DRAW);
const aUv = gl.getAttribLocation(program, "a_uv");
gl.enableVertexAttribArray(aUv);
gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
const gridEBO = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gridEBO);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(gridIdx), gl.STATIC_DRAW);
gl.bindVertexArray(null);

const U = {
  rect: gl.getUniformLocation(program, "uRect"),
  uv: gl.getUniformLocation(program, "uUv"),
  pole: gl.getUniformLocation(program, "uPole"),
  vp: gl.getUniformLocation(program, "uViewProj"),
  sampler: gl.getUniformLocation(program, "uTile"),
  invert: gl.getUniformLocation(program, "uInvert"),
  sea: gl.getUniformLocation(program, "uSea"),
  relief: gl.getUniformLocation(program, "uRelief"),
  texel: gl.getUniformLocation(program, "uTexel"),
};

// ---- atmosphere geometry (a slightly larger sphere, back faces) ---------
const atmoData = buildSphere(1.018, 64, 32);
const atmoVao = gl.createVertexArray();
gl.bindVertexArray(atmoVao);
const atmoVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, atmoVBO);
gl.bufferData(gl.ARRAY_BUFFER, atmoData.pos, gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(atmoProg, "a_pos");
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
const atmoEBO = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, atmoEBO);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, atmoData.idx, gl.STATIC_DRAW);
gl.bindVertexArray(null);
const AU = {
  vp: gl.getUniformLocation(atmoProg, "uViewProj"),
  cam: gl.getUniformLocation(atmoProg, "uCam"),
};

function buildSphere(rad, sx, sy) {
  const pos = [], idx = [];
  for (let j = 0; j <= sy; j++) {
    const v = j / sy, theta = v * Math.PI;
    for (let i = 0; i <= sx; i++) {
      const u = i / sx, phi = u * 2 * Math.PI;
      pos.push(
        rad * Math.sin(theta) * Math.cos(phi),
        rad * Math.cos(theta),
        rad * Math.sin(theta) * Math.sin(phi),
      );
    }
  }
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

// ---- state --------------------------------------------------------------
const params = { invert: 1, sea: 0, relief: 1.0, autoSpin: true };
// camera orbits the globe; the point under the camera is (centerLon, centerLat)
const cam = { lon: 0, lat: 20, dist: 3.2 };
const target = { lon: 0, lat: 20, dist: 3.2 }; // eased toward by input (momentum)
let W = 0, H = 0, dpr = 1, frameId = 0, lastT = 0;

// ---- tile cache + loader (ported from the flat map) ---------------------
const cache = new Map();
let inflight = 0;
function texFromImage(img) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
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
  cache.set(key, { tex: null, lastUsed: frameId });
  inflight++;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { inflight--; const e = cache.get(key); if (e) e.tex = texFromImage(img); };
  img.onerror = () => { inflight--; cache.delete(key); };
  img.src = TILE_URL(z, x, y);
}
function ancestorTex(z, x, y) {
  for (let k = 1; k <= z; k++) {
    const pz = z - k, f = 1 << k;
    const px = Math.floor(x / f), py = Math.floor(y / f);
    const e = cache.get(`${pz}/${px}/${py}`);
    if (e && e.tex) return { tex: e.tex, ox: x / f - px, oy: y / f - py, s: 1 / f };
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

// ---- LOD: choose a tile zoom from how close the camera is ----------------
function zoomForDist(d) {
  // Angular size of one screen pixel at the globe's surface drives the tile
  // detail: closer camera (small altitude) → deeper tiles. Tuned so the whole
  // globe sits around z1–2 and the surface reaches the deep tiles.
  const alt = Math.max(d - R, 1e-3);
  const px = (2 * Math.tan(FOVY / 2)) / H; // radians per pixel at unit distance
  const groundPerPx = px * alt; // surface units per pixel (approx, near sub-point)
  // world is 2πR around; a tile is 1/2^z of it across TILE px
  const z = Math.log2((2 * Math.PI * R) / (groundPerPx * TILE));
  return clamp(Math.round(z), 0, MAX_TILE_Z);
}

const FOVY = (42 * Math.PI) / 180;

// ---- render -------------------------------------------------------------
let firstPaint = false;
function frame(now) {
  frameId++;
  const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 0.016;
  lastT = now;

  // ease camera toward target (smooth momentum) + optional auto-spin
  if (params.autoSpin && !dragging) target.lon += dt * 3.0;
  const k = 1 - Math.exp(-dt * 11);
  cam.lon += angDiff(cam.lon, target.lon) * k;
  cam.lat += (target.lat - cam.lat) * k;
  cam.dist += (target.dist - cam.dist) * k;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.02, 0.03, 0.06, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  const dir = dirOf(cam.lon, cam.lat);
  const eye = [dir[0] * cam.dist, dir[1] * cam.dist, dir[2] * cam.dist];
  const proj = perspective(FOVY, W / H, 0.002, 50);
  const viewProj = mul(proj, lookAt(eye, [0, 0, 0], [0, 1, 0]));

  // globe tiles (front-facing tiles are CPU-culled below; no GL face cull so
  // patch winding can't hide them)
  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.disable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.uniformMatrix4fv(U.vp, false, viewProj);
  gl.uniform1i(U.sampler, 0);
  gl.uniform1f(U.invert, params.invert);
  gl.uniform1f(U.sea, params.sea);
  gl.uniform1f(U.relief, params.relief);
  gl.uniform2f(U.texel, 1 / TILE, 1 / TILE);

  const Z = zoomForDist(cam.dist);
  const n = 1 << Z;
  // visible cap half-angle (horizon), plus margin for the frustum edge
  const cosHorizon = clamp(R / cam.dist, -1, 1);
  const horizon = Math.acos(cosHorizon) + 0.15;
  const center = [dir[0], dir[1], dir[2]];

  // iterate a tile window around the sub-camera point
  const cwx = lonToWX(cam.lon), cwy = clamp(latToWY(clamp(cam.lat, -MERC_LAT, MERC_LAT)), 0, 1);
  const ctx = Math.floor(cwx * n), cty = Math.floor(cwy * n);
  const span = Math.min(n, Math.ceil((horizon / (Math.PI / n)) ) + 2);

  const wanted = [];
  let drawn = 0, want = 0, have = 0;
  for (let dy = -span; dy <= span; dy++) {
    const ty = cty + dy;
    if (ty < 0 || ty >= n) continue;
    for (let dx = -span; dx <= span; dx++) {
      const rawX = ctx + dx;
      const tx = ((rawX % n) + n) % n;
      // cull tiles whose centre is over the horizon (back of the globe)
      const mwx = (tx + 0.5) / n, mwy = (ty + 0.5) / n;
      const sd = sphere(mwx, mwy);
      if (sd[0] * center[0] + sd[1] * center[1] + sd[2] * center[2] < cosHorizon - 0.15) continue;
      want++;
      const key = `${Z}/${tx}/${ty}`;
      const e = cache.get(key);
      let t = null;
      if (e && e.tex) { e.lastUsed = frameId; t = { tex: e.tex, ox: 0, oy: 0, s: 1 }; have++; }
      else { t = ancestorTex(Z, tx, ty); wanted.push([tx, ty]); }
      if (t) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.uniform4f(U.rect, tx / n, ty / n, 1 / n, 0);
        gl.uniform4f(U.uv, t.ox, t.oy, t.s, t.s);
        gl.uniform1f(U.pole, (ty === 0 ? 1 : 0) + (ty === n - 1 ? 2 : 0));
        gl.drawElements(gl.TRIANGLES, gridIdx.length, gl.UNSIGNED_SHORT, 0);
        drawn++;
      }
    }
  }
  // atmosphere rim, drawn after the globe so the surface occludes it and only
  // the halo just outside the silhouette shows
  gl.useProgram(atmoProg);
  gl.bindVertexArray(atmoVao);
  gl.uniformMatrix4fv(AU.vp, false, viewProj);
  gl.uniform3f(AU.cam, eye[0], eye[1], eye[2]);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.FRONT);
  gl.drawElements(gl.TRIANGLES, atmoData.idx.length, gl.UNSIGNED_SHORT, 0);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(null);

  if (wanted.length) {
    wanted.sort(
      (a, b) => (a[0] - ctx) ** 2 + (a[1] - cty) ** 2 - ((b[0] - ctx) ** 2 + (b[1] - cty) ** 2),
    );
    for (const [tx, ty] of wanted) requestTile(Z, tx, ty);
  }
  evict();

  if (!firstPaint && want > 0 && have === want) {
    firstPaint = true;
    $("loader").classList.add("hidden");
  }
  updateReadout(Z);
  requestAnimationFrame(frame);
}

function angDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ---- interaction --------------------------------------------------------
let dragging = false;
const pointers = new Map();
let pinchPrev = null;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragging = true;
  pinchPrev = null;
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const px = p.x, py = p.y;
  p.x = e.clientX; p.y = e.clientY;

  if (pointers.size === 1) {
    // drag to rotate; sensitivity scales with how zoomed-in we are
    const deg = (cam.dist - R) * 90 / H;
    target.lon -= (p.x - px) * deg / Math.max(0.25, Math.cos((cam.lat * Math.PI) / 180));
    target.lat = clamp(target.lat + (p.y - py) * deg, -MERC_LAT, MERC_LAT);
  } else if (pointers.size >= 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchPrev && pinchPrev > 0) target.dist = clamp(target.dist * (pinchPrev / dist), MIN_DIST, MAX_DIST);
    pinchPrev = dist;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) dragging = false;
  if (pointers.size < 2) pinchPrev = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;
  else if (e.deltaMode === 2) d *= H;
  const factor = e.ctrlKey ? 0.012 : 0.0022;
  // exponential zoom in distance → constant feel at every scale
  target.dist = clamp(target.dist * Math.exp(d * factor), MIN_DIST, MAX_DIST);
  if (d > 0) maybeGoFlat(); // zooming out at the limit could return to... (n/a; globe is the top)
}, { passive: false });

// ---- UI -----------------------------------------------------------------
function updateReadout(Z) {
  const el = $("readout");
  if (el) el.textContent = `z${Z} · ${cam.lat.toFixed(1)}, ${cam.lon.toFixed(1)}`;
}
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}
window.addEventListener("resize", resize);

function refreshStats() {
  if (!worldGrid) return;
  let land = 0, tot = 0;
  const { elev, wgt } = worldGrid;
  for (let i = 0; i < elev.length; i++) {
    const e = params.invert ? -elev[i] : elev[i];
    if (e - params.sea > 0) land += wgt[i];
    tot += wgt[i];
  }
  const lf = land / tot;
  if ($("land-pct")) $("land-pct").textContent = `${(lf * 100).toFixed(1)}%`;
  if ($("sea-pct")) $("sea-pct").textContent = `${((1 - lf) * 100).toFixed(1)}%`;
}

function bindUI() {
  const sea = $("sea"), seaV = $("sea-value");
  const relief = $("relief"), reliefV = $("relief-value");
  const modeBtn = $("mode-toggle"), modeV = $("mode-value");
  const spinBtn = $("spin-toggle");
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
  if (relief) relief.addEventListener("input", () => {
    params.relief = +relief.value / 100;
    reliefV.textContent = `${relief.value}%`;
  });
  modeBtn.addEventListener("click", () => { params.invert = params.invert ? 0 : 1; setMode(); });
  if (spinBtn) spinBtn.addEventListener("click", () => {
    params.autoSpin = !params.autoSpin;
    spinBtn.textContent = `⟳ Auto-spin: ${params.autoSpin ? "on" : "off"}`;
  });
  if (uiToggle) uiToggle.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("ui-hidden");
    uiToggle.title = hidden ? "Show controls" : "Hide controls";
  });
  $("reset-view")?.addEventListener("click", () => {
    target.lon = cam.lon; target.lat = 20; target.dist = 3.2;
  });
  // dive into the flat map at the globe's current detail level, for continuity
  $("map-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    goFlat(clamp(zoomForDist(cam.dist), 3, MAX_TILE_Z));
  });
  setMode();
}

// ---- world land/ocean stat (decoded from the z0 world tile) -------------
let worldGrid = null;
function loadWorldStat() {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = TILE; c.height = TILE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    const elev = new Float32Array(TILE * TILE), wgt = new Float32Array(TILE * TILE);
    for (let y = 0; y < TILE; y++) {
      const lat = wyToLat((y + 0.5) / TILE), cl = Math.cos((lat * Math.PI) / 180), w = cl * cl;
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

// ---- handoff to the flat map (dive in) ----------------------------------
function goFlat(zoom) {
  if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) return;
  navigateWithFade("index.html" + buildHash({
    lat: cam.lat, lon: cam.lon, zoom, invert: !!params.invert, sea: params.sea,
  }));
}
let handoffReady = false;
function maybeGoFlat() { /* globe is the outermost view; nothing above it */ }

function applyHashState() {
  const s = readHash();
  if (s.sea != null) {
    const seaEl = $("sea");
    seaEl.value = clamp(s.sea, +seaEl.min, +seaEl.max);
    seaEl.dispatchEvent(new Event("input"));
  }
  if (s.invert != null && params.invert !== (s.invert ? 1 : 0)) $("mode-toggle").click();
  if (s.lat != null && s.lon != null) {
    cam.lon = target.lon = s.lon;
    cam.lat = target.lat = clamp(s.lat, -MERC_LAT, MERC_LAT);
    params.autoSpin = false;
    const sb = $("spin-toggle");
    if (sb) sb.textContent = "⟳ Auto-spin: off";
  }
}

function fail(msg) {
  const l = $("loader");
  if (l) { l.classList.add("error"); const t = $("loader-text"); if (t) t.textContent = msg; }
}

// ---- go -----------------------------------------------------------------
resize();
bindUI();
applyHashState();
loadWorldStat();
requestAnimationFrame(frame);
setTimeout(() => { handoffReady = true; }, 500);
setTimeout(() => $("loader").classList.add("hidden"), 6000);
