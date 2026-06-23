import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ------------------------------------------------------------------ *
 *  Inversia — interactive inverted-Earth globe
 *
 *  The elevation field (real topography + bathymetry) is loaded from a
 *  16-bit heightmap baked by scripts/bake_heightmap.py. Every fragment of
 *  the globe is coloured live in a shader from that elevation, the current
 *  water level, and whether we are showing the real Earth or its inverse.
 * ------------------------------------------------------------------ */

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);

const state = {
  invert: true, // start in Inversia
  seaLevel: 0, // metres
  exaggeration: 25, // vertical-exaggeration factor (slider 0..60)
  autoSpin: true,
};

// ---- load the elevation asset -------------------------------------------
async function loadElevation() {
  const meta = await fetch(`${BASE}heightmap.json`).then((r) => r.json());
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = `${BASE}heightmap.png`;
  });

  const { width: w, height: h, minElev, maxElev } = meta;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // Decode 16-bit elevation (R = high byte, G = low byte) → metres.
  const elev = new Float32Array(w * h);
  const span = maxElev - minElev;
  for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
    elev[i] = ((px[p] * 256 + px[p + 1]) / 65535) * span + minElev;
  }
  return { elev, w, h, minElev, maxElev };
}

// ---- shaders ------------------------------------------------------------
const vertexShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uElev;
  uniform float uMinElev, uMaxElev;
  uniform float uInvert;     // 0 = real Earth, 1 = Inversia
  uniform float uSea;        // flood level, metres
  uniform float uExag;       // relief exaggeration (radius units per 8000 m)

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vElev;       // effective elevation at this vertex (metres)

  void main() {
    vUv = uv;
    float e = texture2D(uElev, uv).r;          // metres
    float eff = mix(e, -e, uInvert);           // invert reflects around sea level 0
    vElev = eff;

    float above = eff - uSea;                  // metres above the flood line
    vec3 n = normalize(position);
    // Land rises above the (flat) water surface; ocean stays at the sphere radius.
    // Divide by Earth's radius so uExag is a true vertical-exaggeration factor
    // (×1 = real proportions). Real relief is tiny on a globe, hence the boost.
    float r = 1.0 + max(above, 0.0) / 6371000.0 * uExag;
    vec3 displaced = n * r;

    vec4 wp = modelMatrix * vec4(displaced, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uElev;
  uniform vec2 uTexel;       // 1/width, 1/height
  uniform float uInvert;
  uniform float uSea;
  uniform float uExag;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vElev;

  float effElev(vec2 uv) {
    float e = texture2D(uElev, uv).r;
    return mix(e, -e, uInvert);
  }

  // Hypsometric land tint by height (metres above the water line).
  vec3 landColor(float h) {
    vec3 c = vec3(0.85, 0.78, 0.60);                       // beach / sand
    c = mix(c, vec3(0.30, 0.48, 0.24), smoothstep(0.0, 60.0, h));      // lowland green
    c = mix(c, vec3(0.42, 0.55, 0.26), smoothstep(60.0, 500.0, h));    // green
    c = mix(c, vec3(0.60, 0.60, 0.28), smoothstep(500.0, 1100.0, h));  // yellow-green
    c = mix(c, vec3(0.52, 0.40, 0.24), smoothstep(1100.0, 2000.0, h)); // brown
    c = mix(c, vec3(0.40, 0.31, 0.22), smoothstep(2000.0, 3000.0, h)); // dark brown
    c = mix(c, vec3(0.62, 0.60, 0.57), smoothstep(3000.0, 4200.0, h)); // rock grey
    c = mix(c, vec3(0.96, 0.97, 1.00), smoothstep(4200.0, 5600.0, h)); // snow
    return c;
  }

  // Ocean tint by depth (metres below the water line).
  vec3 seaColor(float d) {
    vec3 c = vec3(0.23, 0.62, 0.74);                       // turquoise shallows
    c = mix(c, vec3(0.16, 0.45, 0.69), smoothstep(0.0, 350.0, d));
    c = mix(c, vec3(0.12, 0.35, 0.59), smoothstep(350.0, 1800.0, d));
    c = mix(c, vec3(0.09, 0.25, 0.47), smoothstep(1800.0, 3800.0, d));
    c = mix(c, vec3(0.05, 0.14, 0.31), smoothstep(3800.0, 6500.0, d)); // deep navy
    return c;
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCamPos - vPosW);

    float above = vElev - uSea;
    bool isLand = above > 0.0;

    // Tangent frame on the sphere for bump shading from the heightmap.
    vec3 up = abs(N.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 east = normalize(cross(up, N));
    vec3 north = normalize(cross(N, east));

    float eR = effElev(vUv + vec2(uTexel.x, 0.0));
    float eL = effElev(vUv - vec2(uTexel.x, 0.0));
    float eU = effElev(vUv + vec2(0.0, uTexel.y));
    float eD = effElev(vUv - vec2(0.0, uTexel.y));

    vec3 shadeN = N;
    if (isLand) {
      // slope → tilt the normal so relief catches the light (hillshade).
      // Clamp the slope so the big elevation jump at coastlines doesn't over-tilt.
      float bump = 0.0009;
      float du = clamp(eR - eL, -1500.0, 1500.0);
      float dv = clamp(eU - eD, -1500.0, 1500.0);
      shadeN = normalize(N - east * du * bump - north * dv * bump);
    }

    float diff = max(dot(shadeN, uSunDir), 0.0);
    float amb = 0.30;

    vec3 base;
    if (isLand) {
      base = landColor(above);
    } else {
      base = seaColor(-above);
    }

    vec3 col = base * (amb + diff * 0.95);

    // Specular sheen on water only.
    if (!isLand) {
      vec3 H = normalize(uSunDir + V);
      float spec = pow(max(dot(N, H), 0.0), 70.0);
      col += vec3(0.7, 0.85, 1.0) * spec * 0.45;
    }

    // Atmospheric rim light.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += vec3(0.18, 0.40, 0.75) * fres * 0.9;

    // gentle tone curve
    col = pow(col, vec3(0.92));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- atmosphere glow shell ----------------------------------------------
const atmoVert = /* glsl */ `
  varying vec3 vN; varying vec3 vP;
  void main() {
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vP = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const atmoFrag = /* glsl */ `
  varying vec3 vN; varying vec3 vP;
  uniform vec3 uCamPos;
  void main() {
    vec3 V = normalize(uCamPos - vP);
    float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 4.0);
    gl_FragColor = vec4(vec3(0.30, 0.55, 1.0) * rim, rim);
  }
`;

// ---- main ---------------------------------------------------------------
async function main() {
  let data;
  try {
    data = await loadElevation();
  } catch (e) {
    return fail("Could not load the elevation data.");
  }

  const canvasHost = $("app");
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) {
    // float textures still work via extension on WebGL1, but bail loudly if no GL at all.
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05070d, 1);
  canvasHost.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, 0.6, 3.0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 1.35;
  controls.maxDistance = 7;
  controls.rotateSpeed = 0.5;

  // Elevation as a linear-filterable texture.
  // DataTexture ignores flipY, while SphereGeometry uses the image convention
  // (north at v=1), so flip the rows here (our data row 0 = north). HalfFloat is
  // core-filterable in WebGL2, avoiding a blocky nearest-filter fallback.
  const half = new Uint16Array(data.w * data.h);
  for (let y = 0; y < data.h; y++) {
    const src = (data.h - 1 - y) * data.w;
    const dst = y * data.w;
    for (let x = 0; x < data.w; x++) {
      half[dst + x] = THREE.DataUtils.toHalfFloat(data.elev[src + x]);
    }
  }
  const elevTex = new THREE.DataTexture(
    half, data.w, data.h, THREE.RedFormat, THREE.HalfFloatType,
  );
  elevTex.wrapS = THREE.RepeatWrapping;
  elevTex.wrapT = THREE.ClampToEdgeWrapping;
  elevTex.minFilter = THREE.LinearFilter;
  elevTex.magFilter = THREE.LinearFilter;
  elevTex.needsUpdate = true;

  const sunDir = new THREE.Vector3(0.6, 0.35, 0.7).normalize();

  const uniforms = {
    uElev: { value: elevTex },
    uTexel: { value: new THREE.Vector2(1 / data.w, 1 / data.h) },
    uMinElev: { value: data.minElev },
    uMaxElev: { value: data.maxElev },
    uInvert: { value: state.invert ? 1 : 0 },
    uSea: { value: state.seaLevel },
    uExag: { value: state.exaggeration },
    uSunDir: { value: sunDir },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
  };

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 512, 256),
    new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms }),
  );
  scene.add(globe);

  // atmosphere
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.045, 96, 48),
    new THREE.ShaderMaterial({
      vertexShader: atmoVert,
      fragmentShader: atmoFrag,
      uniforms: { uCamPos: uniforms.uCamPos },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(atmo);

  scene.add(makeStarfield());

  // ---- stats (area-weighted land fraction) ------------------------------
  // downsample once for cheap recomputation while dragging the slider
  const SW = 360, SH = 180;
  const statGrid = new Float32Array(SW * SH);
  const cosLat = new Float32Array(SH);
  for (let y = 0; y < SH; y++) {
    const lat = (0.5 - (y + 0.5) / SH) * Math.PI; // +pi/2 .. -pi/2
    cosLat[y] = Math.cos(lat);
    for (let x = 0; x < SW; x++) {
      const sx = Math.floor((x / SW) * data.w);
      const sy = Math.floor((y / SH) * data.h);
      statGrid[y * SW + x] = data.elev[sy * data.w + sx];
    }
  }
  function landFraction() {
    let land = 0, tot = 0;
    for (let y = 0; y < SH; y++) {
      const wgt = cosLat[y];
      for (let x = 0; x < SW; x++) {
        let e = statGrid[y * SW + x];
        if (state.invert) e = -e;
        if (e - state.seaLevel > 0) land += wgt;
        tot += wgt;
      }
    }
    return land / tot;
  }

  // ---- UI wiring --------------------------------------------------------
  bindUI({ uniforms, controls, landFraction });

  // ---- resize -----------------------------------------------------------
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", onResize);

  // ---- render loop ------------------------------------------------------
  const clock = new THREE.Clock();
  function tick() {
    const dt = clock.getDelta();
    if (state.autoSpin) globe.rotation.y += dt * 0.05;
    atmo.rotation.copy(globe.rotation);
    controls.update();
    uniforms.uCamPos.value.copy(camera.position);
    uniforms.uTime.value += dt;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  $("loader").classList.add("hidden");
  tick();
}

function makeStarfield() {
  const n = 1800;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 30 + Math.random() * 40;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(p) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    pos[i * 3 + 2] = r * Math.cos(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    g,
    new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.13, sizeAttenuation: true, transparent: true, opacity: 0.8 }),
  );
}

function bindUI({ uniforms, controls, landFraction }) {
  const seaEl = $("sea"), seaVal = $("sea-value");
  const exagEl = $("exag"), exagVal = $("exag-value");
  const modeBtn = $("mode-toggle"), modeVal = $("mode-value");
  const spinBtn = $("spin-toggle");
  const landPct = $("land-pct"), seaPct = $("sea-pct");

  function refreshStats() {
    const lf = landFraction();
    landPct.textContent = `${(lf * 100).toFixed(1)}%`;
    seaPct.textContent = `${((1 - lf) * 100).toFixed(1)}%`;
  }
  function setMode() {
    modeVal.textContent = state.invert ? "Inversia" : "Real Earth";
    uniforms.uInvert.value = state.invert ? 1 : 0;
    refreshStats();
  }

  seaEl.addEventListener("input", () => {
    state.seaLevel = +seaEl.value;
    uniforms.uSea.value = state.seaLevel;
    seaVal.textContent = `${state.seaLevel > 0 ? "+" : ""}${state.seaLevel} m`;
    refreshStats();
  });
  exagEl.addEventListener("input", () => {
    state.exaggeration = +exagEl.value;
    uniforms.uExag.value = state.exaggeration;
    exagVal.textContent = `×${state.exaggeration}`;
  });
  modeBtn.addEventListener("click", () => { state.invert = !state.invert; setMode(); });
  spinBtn.addEventListener("click", () => {
    state.autoSpin = !state.autoSpin;
    spinBtn.textContent = `⟳ Auto-spin: ${state.autoSpin ? "on" : "off"}`;
  });
  $("reset-view").addEventListener("click", () => controls.reset());

  setMode();
}

function fail(msg) {
  const l = $("loader");
  l.classList.add("error");
  $("loader-text").textContent = msg;
}

main();
