import {
  TILE, MAX_TILE_Z, FRAG, clamp,
  lonToWX, latToWY,
  linkProgram, createTileCache,
} from "./terrain.js";

/* ------------------------------------------------------------------ *
 *  Inversia — streaming tiled globe (spherical presentation)
 *
 *  The SAME Web-Mercator elevation tiles the flat map streams, wrapped onto a
 *  sphere. Each visible tile is a curved patch whose vertices are placed on the
 *  globe from the tile's lon/lat extent, textured and coloured by the SHARED
 *  terrain fragment shader (see terrain.js) — so the globe and the map are one
 *  world in two projections.
 *
 *  Exposed as a factory so the orchestrator (app.js) can mount it on a canvas,
 *  share state with the map, and crossfade between the two.
 * ------------------------------------------------------------------ */

const GRID = 12;       // patch subdivision (GRID×GRID quads per tile)
const R = 1.0;         // globe radius
const MIN_DIST = 1.025; // closest the camera comes to the surface
const MAX_DIST = 7.0;
const MERC_LAT = 85.0511; // Web-Mercator latitude limit
const FOVY = (42 * Math.PI) / 180;

// ---- pure geometry helpers ----------------------------------------------
const lonToWXg = lonToWX;
const latToWYg = latToWY;

// world (mercator 0..1) → unit sphere position
function sphere(wx, wy) {
  const lon = (wx * 360 - 180) * (Math.PI / 180);
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy)));
  const cl = Math.cos(lat);
  return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}
function dirOf(lon, lat) {
  const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180, cl = Math.cos(b);
  return [cl * Math.sin(a), Math.sin(b), cl * Math.cos(a)];
}
function angDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
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
  if (mod(uPole, 2.0) >= 1.0 && a_uv.y == 0.0) wy = -2.0;
  else if (uPole >= 2.0 && a_uv.y == 1.0) wy = 3.0;
  float lon = wx * 2.0 * PI - PI;
  float lat = atan(sinh(PI * (1.0 - 2.0 * wy)));
  float cl = cos(lat);
  vec3 p = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
  vUv = uUv.xy + a_uv * uUv.zw;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

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

// Mount the globe renderer on `canvas`, reading live from shared `params`
// ({ invert, sea, relief }). hooks: { onZoomIn(geo), onReadout(text) }.
export function createGlobeView(canvas, params, hooks = {}) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) throw new Error("no webgl2");

  const program = linkProgram(gl, VERT, FRAG);
  const atmoProg = linkProgram(gl, ATMO_VERT, ATMO_FRAG);

  // ---- patch grid geometry (shared by every tile) ----------------------
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

  // ---- atmosphere geometry ---------------------------------------------
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

  // ---- state ------------------------------------------------------------
  const cam = { lon: 0, lat: 20, dist: 3.2 };
  const target = { lon: 0, lat: 20, dist: 3.2 };
  let W = 0, H = 0, dpr = 1;
  let running = false, rafId = 0, lastT = 0;
  let active = false;
  // last frame's camera, kept so the vector overlay can project lon/lat onto
  // exactly what the GPU just drew: { vp, dir, cosHorizon }
  let lastProj = null;

  const tiles = createTileCache(gl);

  // ---- LOD: choose a tile zoom from camera distance --------------------
  function zoomForDistF(d) {
    const alt = Math.max(d - R, 1e-3);
    const px = (2 * Math.tan(FOVY / 2)) / H;
    const groundPerPx = px * alt;
    return Math.log2((2 * Math.PI * R) / (groundPerPx * TILE));
  }
  function zoomForDist(d) { return clamp(Math.round(zoomForDistF(d)), 0, MAX_TILE_Z); }
  function distForZoom(z) {
    const px = (2 * Math.tan(FOVY / 2)) / H;
    const groundPerPx = (2 * Math.PI * R) / (Math.pow(2, z) * TILE);
    return clamp(R + groundPerPx / px, MIN_DIST, MAX_DIST);
  }

  // ---- render -----------------------------------------------------------
  function frame(now) {
    if (!running) return;
    tiles.tick();
    const frameId = tiles.frame;
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 0.016;
    lastT = now;

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
    const cosHorizon = clamp(R / cam.dist, -1, 1);
    const horizon = Math.acos(cosHorizon) + 0.15;
    const center = [dir[0], dir[1], dir[2]];
    lastProj = { vp: viewProj, dir, cosHorizon };

    const cwx = lonToWXg(cam.lon), cwy = clamp(latToWYg(clamp(cam.lat, -MERC_LAT, MERC_LAT)), 0, 1);
    const ctx = Math.floor(cwx * n), cty = Math.floor(cwy * n);
    const span = Math.min(n, Math.ceil(horizon / (Math.PI / n)) + 2);

    const wanted = [];
    for (let dy = -span; dy <= span; dy++) {
      const ty = cty + dy;
      if (ty < 0 || ty >= n) continue;
      for (let dx = -span; dx <= span; dx++) {
        const rawX = ctx + dx;
        const tx = ((rawX % n) + n) % n;
        const mwx = (tx + 0.5) / n, mwy = (ty + 0.5) / n;
        const sd = sphere(mwx, mwy);
        if (sd[0] * center[0] + sd[1] * center[1] + sd[2] * center[2] < cosHorizon - 0.15) continue;
        const key = `${Z}/${tx}/${ty}`;
        const e = tiles.get(key);
        let t = null;
        if (e && e.tex) { tiles.touch(e); t = { tex: e.tex, ox: 0, oy: 0, s: 1 }; }
        else { t = tiles.ancestor(Z, tx, ty); wanted.push([tx, ty]); }
        if (t) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.uniform4f(U.rect, tx / n, ty / n, 1 / n, 0);
          gl.uniform4f(U.uv, t.ox, t.oy, t.s, t.s);
          gl.uniform1f(U.pole, (ty === 0 ? 1 : 0) + (ty === n - 1 ? 2 : 0));
          gl.drawElements(gl.TRIANGLES, gridIdx.length, gl.UNSIGNED_SHORT, 0);
        }
      }
    }

    // atmosphere rim, drawn after the globe so the surface occludes it
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
      for (const [tx, ty] of wanted) tiles.request(Z, tx, ty);
    }
    tiles.evict();

    if (hooks.onReadout) hooks.onReadout(`z${Z} · ${cam.lat.toFixed(1)}, ${cam.lon.toFixed(1)}`);
    rafId = requestAnimationFrame(frame);
  }

  // ---- interaction ------------------------------------------------------
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
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pointers.size === 1) {
      const deg = (cam.dist - R) * 90 / H;
      target.lon -= (p.x - px) * deg / Math.max(0.25, Math.cos((cam.lat * Math.PI) / 180));
      target.lat = clamp(target.lat + (p.y - py) * deg, -MERC_LAT, MERC_LAT);
    } else if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchPrev && pinchPrev > 0) {
        target.dist = clamp(target.dist * (pinchPrev / dist), MIN_DIST, MAX_DIST);
        maybeZoomIn(pinchPrev / dist);
      }
      pinchPrev = dist;
    }
  }
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
  }
  function onWheel(e) {
    e.preventDefault();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= H;
    const factor = e.ctrlKey ? 0.012 : 0.0022;
    target.dist = clamp(target.dist * Math.exp(d * factor), MIN_DIST, MAX_DIST);
    if (d < 0) maybeZoomIn(Math.exp(d * factor));
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // ---- zoom-in → hand off to the flat map ------------------------------
  // Both presentations cross over at the same detail level (hooks.switchZoom):
  // once zooming in carries the globe past it, dive into the streaming map at
  // matching detail so the swap is seamless.
  const SWITCH = hooks.switchZoom ?? 6;
  function maybeZoomIn() {
    if (!active || !hooks.onZoomIn) return;
    if (zoomForDistF(target.dist) < SWITCH) return;
    if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) return;
    // open the map a touch deeper than the crossover so it sits inside its own
    // range and won't immediately bounce back to the globe
    hooks.onZoomIn({ lat: cam.lat, lon: cam.lon, zoom: SWITCH + 0.6 });
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

  // ---- public handle ----------------------------------------------------
  return {
    canvas,
    start() { if (!running) { running = true; lastT = 0; active = true; rafId = requestAnimationFrame(frame); } },
    stop() { running = false; active = false; cancelAnimationFrame(rafId); },
    setActive(on) { active = on; },
    getGeo() { return { lat: cam.lat, lon: cam.lon, zoom: zoomForDist(cam.dist) }; },
    setGeo({ lat, lon, zoom, overview }) {
      if (lon != null) cam.lon = target.lon = lon;
      if (lat != null) cam.lat = target.lat = clamp(lat, -MERC_LAT, MERC_LAT);
      // Land at the camera distance that shows the same detail the map was at,
      // so the crossfade lines up. (Map hands off below the crossover zoom, so
      // this sits below the dive-in trigger and won't bounce.)
      if (overview) { cam.dist = target.dist = 3.2; }
      else if (zoom != null) { cam.dist = target.dist = distForZoom(zoom); }
    },
    zoomBy(factor) {
      // factor < 1 zooms in, > 1 zooms out (multiplicative on distance)
      target.dist = clamp(target.dist * factor, MIN_DIST, MAX_DIST);
      if (factor < 1) maybeZoomIn();
    },
    reset() { target.lon = cam.lon; target.lat = 20; target.dist = 3.2; },
    // lon/lat → screen px (CSS px) through last frame's view-projection, for the
    // vector overlay. Points on the far hemisphere (behind the limb) report
    // vis:false so the overlay can drop border segments the globe occludes.
    project(lon, lat) {
      if (!lastProj) return { x: 0, y: 0, vis: false };
      const p = dirOf(lon, lat); // surface point on the unit sphere (R = 1)
      const { vp, dir, cosHorizon } = lastProj;
      if (p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2] < cosHorizon)
        return { x: 0, y: 0, vis: false };
      const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (cw <= 0) return { x: 0, y: 0, vis: false };
      const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
      const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      return {
        x: (cx / cw * 0.5 + 0.5) * W,
        y: (1 - (cy / cw * 0.5 + 0.5)) * H,
        vis: true,
      };
    },
  };
}
