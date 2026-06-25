/* ------------------------------------------------------------------ *
 *  Inversia — shared terrain core
 *
 *  The globe and the flat map are two presentations of ONE dataset. Everything
 *  that defines "what Inversia looks like" lives here so the two views can
 *  never drift apart: the tile source, the Web-Mercator helpers, the fragment
 *  shader (decode → invert → flood → hypsometric colour + hillshade) and the
 *  global land/ocean statistic. Each view supplies only its own vertex stage
 *  (a flat screen quad vs. a curved sphere patch) and its own camera.
 *
 *  Tile elevation (Terrarium):  e = R*256 + G + B/256 - 32768   (metres)
 * ------------------------------------------------------------------ */

export const TILE = 256;
export const MAX_TILE_Z = 15; // deepest tiles AWS serves
export const CACHE_LIMIT = 600;
export const MAX_INFLIGHT = 8;

export const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// ---- mercator helpers (world coords in 0..1) ----------------------------
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lonToWX = (lon) => (lon + 180) / 360;
export const latToWY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const wxToLon = (x) => x * 360 - 180;
export const wyToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

// ---- shared fragment shader (GLSL ES 3.00) ------------------------------
// Identical for both views: decode the packed elevation, optionally invert it,
// flood everything below the water level, colour it hypsometrically and
// hillshade from the local slope — so the globe and map read as one world.
export const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTile;
uniform float uInvert;   // 0 real, 1 inversia
uniform float uSea;      // water level, metres
uniform float uRelief;   // hillshade strength 0..2
uniform float uBiome;    // 0 hypsometric ramp, 1 neutral relief (under vector land-cover)
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

// Neutral land tone for the "Natural" style: the live terrain becomes a soft,
// near-colourless relief (the hillshade still reads) so the crisp vector land-cover
// zones drawn over it supply the colour. A faint lift with altitude keeps high
// ground from going flat. Oceans keep their blue (seaColor) — only land is neutral.
vec3 reliefBase(float h) {
  vec3 lo = vec3(0.82, 0.81, 0.77);
  vec3 hi = vec3(0.90, 0.89, 0.86);
  return mix(lo, hi, smoothstep(0.0, 3500.0, h));
}

void main() {
  float e = decode(vUv);
  float eff = mix(e, -e, uInvert);
  float above = eff - uSea;
  bool land = above > 0.0;
  vec3 landC = uBiome > 0.5 ? reliefBase(above) : landColor(above);
  vec3 base = land ? landC : seaColor(-above);

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

// ---- GL helpers ---------------------------------------------------------
export function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}
export function linkProgram(gl, vertSrc, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) || "link failed");
  return p;
}

// ---- per-context streaming tile cache -----------------------------------
// One instance per GL context. Reserves a slot before fetching to avoid
// duplicate requests, evicts least-recently-used textures past the limit, and
// can fall back to an already-loaded ancestor tile while a child streams in.
//
// `onLoad` (optional) fires after a tile's texture is ready. The slippy map
// drives its own rAF loop and ignores it, but MapLibre's custom layer only
// repaints on demand, so it uses this to `triggerRepaint()` as tiles stream in.
export function createTileCache(gl, onLoad) {
  const cache = new Map(); // key -> { tex, lastUsed }
  let inflight = 0;
  let frameId = 0;

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

  return {
    tick() { frameId++; return frameId; },
    get frame() { return frameId; },
    get(key) { return cache.get(key); },
    touch(e) { e.lastUsed = frameId; },
    request(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (cache.has(key)) return;
      if (inflight >= MAX_INFLIGHT) return;
      cache.set(key, { tex: null, lastUsed: frameId }); // reserve
      inflight++;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { inflight--; const e = cache.get(key); if (e) { e.tex = texFromImage(img); onLoad?.(); } };
      img.onerror = () => { inflight--; cache.delete(key); }; // allow retry
      img.src = TILE_URL(z, x, y);
    },
    ancestor(z, x, y) {
      for (let k = 1; k <= z; k++) {
        const pz = z - k, f = 1 << k;
        const px = Math.floor(x / f), py = Math.floor(y / f);
        const e = cache.get(`${pz}/${px}/${py}`);
        if (e && e.tex) return { tex: e.tex, ox: x / f - px, oy: y / f - py, s: 1 / f };
      }
      return null;
    },
    evict() {
      if (cache.size <= CACHE_LIMIT) return;
      const entries = [...cache.entries()].filter((e) => e[1].tex);
      entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (let i = 0; i < entries.length && cache.size > CACHE_LIMIT * 0.85; i++) {
        gl.deleteTexture(entries[i][1].tex);
        cache.delete(entries[i][0]);
      }
    },
  };
}

// ---- global land/ocean stat (decoded once from the z0 world tile) -------
let worldGrid = null;
let pending = null;
export function loadWorldStat() {
  if (worldGrid) return Promise.resolve(worldGrid);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = TILE; c.height = TILE;
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
      resolve(worldGrid);
    };
    img.onerror = () => resolve(null);
    img.src = TILE_URL(0, 0, 0);
  });
  return pending;
}
export function landFraction(invert, sea) {
  if (!worldGrid) return null;
  let land = 0, tot = 0;
  const { elev, wgt } = worldGrid;
  for (let i = 0; i < elev.length; i++) {
    const e = invert ? -elev[i] : elev[i];
    if (e - sea > 0) land += wgt[i];
    tot += wgt[i];
  }
  return land / tot;
}
