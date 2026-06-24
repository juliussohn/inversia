import "./style.css";
import { createMapView } from "./map.js";
import { createGlobeView } from "./tileglobe.js";
import { loadWorldStat, landFraction, clamp } from "./terrain.js";
import { readHash, buildHash } from "./handoff.js";
import { createOverlay } from "./overlay.js";
import { createFeatureLayer } from "./features/layer.js";

/* ------------------------------------------------------------------ *
 *  Inversia — one world, two presentations
 *
 *  The globe and the flat map are no longer separate pages: they're two
 *  renderers mounted on the same page, sharing one `params` object (water
 *  level, inversion, relief) so every control updates both in lock-step. Only
 *  one is shown at a time; zooming all the way out crossfades to the globe and
 *  zooming into the surface crossfades to the map — no reload, no URL handoff.
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

// shared world state — both renderers read this live each frame
const params = { invert: 1, sea: 0, relief: 1.0 };

// The globe and map cross over at this detail level in both directions. Picked
// so the two presentations show matching detail at the swap — zoom in past it
// on the globe and you're on the map; zoom out below it and you're back on the
// globe — making the crossfade hard to notice.
const SWITCH_ZOOM = 6;

// Globe presentation is currently disabled — the app shows only the flat map.
// Flip this back to `true` to restore the zoom-out-to-globe crossfade; all the
// globe wiring below is guarded by it, so nothing else needs to change.
const GLOBE_ENABLED = false;

let mode = GLOBE_ENABLED ? "globe" : "map"; // "globe" | "map"
let switching = false;       // guards against re-entrant / bouncing switches

// ---- mount the renderer(s) -----------------------------------------------
let globe = null, map;
try {
  if (GLOBE_ENABLED) {
    globe = createGlobeView($("globe-canvas"), params, {
      switchZoom: SWITCH_ZOOM,
      onZoomIn: (geo) => switchTo("map", geo),
      onReadout: (t) => { if (mode === "globe") setReadout(t); },
    });
  }
  map = createMapView($("map"), params, {
    switchZoom: SWITCH_ZOOM,
    // only hand zoom-out back to the globe when the globe exists
    onZoomOut: GLOBE_ENABLED ? (geo) => switchTo("globe", geo) : undefined,
    onReadout: (t) => { if (mode === "map") setReadout(t); },
  });
} catch (err) {
  fail("Your browser/WebGL2 can't run Inversia.");
  throw err;
}
map.bindMeDot($("me-dot"));

// ---- procedural vector features (borders, later cities/lakes) -----------
// One overlay canvas + one feature layer, shared by both presentations. The
// layer regenerates (debounced) when the world changes; the overlay draws the
// latest geometry through whichever view is active each frame.
const overlay = createOverlay($("overlay"));
const features = createFeatureLayer(params);

function overlayFrame() {
  overlay.render(activeView().project, features.getFeatures());
  requestAnimationFrame(overlayFrame);
}
requestAnimationFrame(overlayFrame);

function setReadout(t) { const el = $("readout"); if (el) el.textContent = t; }
function activeView() { return mode === "globe" ? globe : map; }

// ---- crossfade between presentations ------------------------------------
function switchTo(next, geo) {
  if (switching || next === mode) return;
  switching = true;

  const incoming = next === "globe" ? globe : map;
  const outgoing = next === "globe" ? map : globe;

  // place the incoming view where the outgoing one was looking and swap to it
  // instantly (no fade)
  incoming.setGeo({ lat: geo.lat, lon: geo.lon, zoom: geo.zoom });
  incoming.start();
  outgoing.stop();

  mode = next;
  document.body.classList.toggle("mode-globe", next === "globe");
  document.body.classList.toggle("mode-map", next === "map");
  incoming.canvas.classList.remove("inactive");
  outgoing.canvas.classList.add("inactive");
  syncHash();

  // brief debounce so a single zoom gesture can't fire the reverse switch
  setTimeout(() => { switching = false; }, 150);
}

// ---- shared control panel ------------------------------------------------
function bindUI() {
  const sea = $("sea"), seaV = $("sea-value");
  const relief = $("relief"), reliefV = $("relief-value");
  const modeBtn = $("mode-toggle"), modeV = $("mode-value");
  const viewToggle = $("view-toggle");
  const uiToggle = $("ui-toggle");

  function setInvertLabel() { modeV.textContent = params.invert ? "Inversia" : "Real Earth"; }

  sea.addEventListener("input", () => {
    params.sea = +sea.value;
    seaV.textContent = `${params.sea > 0 ? "+" : ""}${params.sea} m`;
    refreshStats();
    features.invalidate(); // coastlines moved → regrow borders (debounced)
    syncHash();
  });
  relief.addEventListener("input", () => {
    params.relief = +relief.value / 100;
    reliefV.textContent = `${relief.value}%`;
  });
  modeBtn.addEventListener("click", () => {
    params.invert = params.invert ? 0 : 1;
    setInvertLabel();
    refreshStats();
    features.invalidate(); // a different world ⇒ a different political map
    syncHash();
  });

  // manual presentation toggle (independent of zoom). Open the map above the
  // crossover so it doesn't immediately read as "zoomed out". With the globe
  // disabled there's nothing to switch to, so hide the control entirely.
  if (viewToggle && !GLOBE_ENABLED) viewToggle.style.display = "none";
  else if (viewToggle) viewToggle.addEventListener("click", () => {
    if (switching) return;
    const geo = activeView().getGeo();
    if (mode === "globe") switchTo("map", { ...geo, zoom: clamp(Math.max(geo.zoom, SWITCH_ZOOM + 1), SWITCH_ZOOM + 0.6, 13) });
    else switchTo("globe", geo);
  });

  uiToggle.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("ui-hidden");
    uiToggle.title = hidden ? "Show controls" : "Hide controls";
  });

  // zoom buttons drive whichever view is active
  $("zoom-in").addEventListener("click", () => {
    if (mode === "map") map.zoomBy(1);
    else globe.zoomBy(0.82); // multiplicative on distance → zoom in
  });
  $("zoom-out").addEventListener("click", () => {
    if (mode === "map") map.zoomBy(-1);
    else globe.zoomBy(1.22);
  });

  $("reset-view").addEventListener("click", () => activeView().reset());

  bindLocate();
  buildLayerToggles();
  setInvertLabel();
}

// ---- feature toggles -----------------------------------------------------
// Built from the layer's registry, so adding a feature type (cities, lakes…)
// surfaces a checkbox here automatically — no per-type UI code.
function buildLayerToggles() {
  const host = $("layers");
  if (!host) return;
  for (const t of features.types()) {
    const id = `layer-${t.id}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.id = id; cb.checked = t.on;
    cb.addEventListener("change", () => features.setEnabled(t.id, cb.checked));
    label.append(cb, document.createTextNode(t.label));
    host.appendChild(label);
  }
}

// ---- "go to my location" -------------------------------------------------
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
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        map.setMeMarker(lat, lon);
        // locating always lands you on the detailed map
        if (mode === "map") map.flyToLatLon(lat, lon, 12);
        else switchTo("map", { lat, lon, zoom: 12 });
      },
      () => {
        btn.classList.remove("busy");
        btn.title = "Couldn't get your location";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

// ---- land/ocean statistic ------------------------------------------------
function refreshStats() {
  const lf = landFraction(params.invert, params.sea);
  if (lf == null) return;
  if ($("land-pct")) $("land-pct").textContent = `${(lf * 100).toFixed(1)}%`;
  if ($("sea-pct")) $("sea-pct").textContent = `${((1 - lf) * 100).toFixed(1)}%`;
}

// ---- shareable URL hash --------------------------------------------------
// Keep a deep-link in the address bar so a shared URL restores where you were
// and how the world was set. We replaceState (no history spam).
function syncHash() {
  const geo = activeView().getGeo();
  const h = buildHash({
    lat: geo.lat, lon: geo.lon, zoom: geo.zoom,
    invert: !!params.invert, sea: params.sea,
  });
  history.replaceState(null, "", h);
}

function applyHashState() {
  const s = readHash();
  if (s.sea != null) {
    const seaEl = $("sea");
    seaEl.value = clamp(s.sea, +seaEl.min, +seaEl.max);
    seaEl.dispatchEvent(new Event("input"));
  }
  if (s.invert != null && params.invert !== (s.invert ? 1 : 0)) $("mode-toggle").click();
  // a link zoomed in past the crossover opens straight into the map; otherwise
  // the globe is the natural landing view
  if (s.lat != null && s.lon != null) {
    if (!GLOBE_ENABLED || (s.zoom != null && s.zoom >= SWITCH_ZOOM)) {
      mode = "map";
      map.setGeo({ lat: s.lat, lon: s.lon, zoom: s.zoom });
    } else {
      globe.setGeo({ lat: s.lat, lon: s.lon, zoom: s.zoom });
    }
  }
}

// ---- error overlay -------------------------------------------------------
function fail(msg) {
  const l = $("loader");
  if (l) { l.classList.add("error"); const t = $("loader-text"); if (t) t.textContent = msg; }
}

// ---- go ------------------------------------------------------------------
bindUI();
applyHashState();
loadWorldStat().then(refreshStats);

// show the chosen presentation, park the other one
document.body.classList.toggle("mode-globe", mode === "globe");
document.body.classList.toggle("mode-map", mode === "map");
// park the inactive canvas (the globe's element may have no renderer at all)
const idle = mode === "globe" ? map.canvas : (globe ? globe.canvas : $("globe-canvas"));
if (idle) idle.classList.add("inactive");
activeView().start();
syncHash();

// hide the loader once we're up (renderers paint immediately from cache/ancestors)
setTimeout(() => $("loader").classList.add("hidden"), 600);
// safety net: never leave the loader spinning forever
setTimeout(() => $("loader").classList.add("hidden"), 6000);
