/* ------------------------------------------------------------------ *
 *  Cross-view handoff between the globe (overview) and the zoomable map
 *  (detail). The two are separate pages; we carry the shared view state
 *  — where you are and how the world is set — across them in the URL hash
 *  and mask the page swap with a short fade, so it reads as one
 *  continuous zoom (globe ⟶ dive into map, map ⟶ fly up to globe).
 *
 *  Hash format:  #lat=..&lon=..&z=..&v=<0|1>&sea=<m>
 *    lat,lon : centre of the view, degrees
 *    z       : map zoom (ignored by the globe)
 *    v       : 1 = Inversia (inverted), 0 = real Earth
 *    sea     : water level, metres
 * ------------------------------------------------------------------ */

export function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  const num = (k) => {
    const v = parseFloat(p.get(k));
    return Number.isFinite(v) ? v : null;
  };
  return {
    lat: p.has("lat") ? num("lat") : null,
    lon: p.has("lon") ? num("lon") : null,
    zoom: p.has("z") ? num("z") : null,
    invert: p.has("v") ? p.get("v") === "1" : null,
    sea: p.has("sea") ? num("sea") : null,
  };
}

export function buildHash({ lat, lon, zoom, invert, sea } = {}) {
  const p = new URLSearchParams();
  if (lat != null) p.set("lat", lat.toFixed(4));
  if (lon != null) p.set("lon", lon.toFixed(4));
  if (zoom != null) p.set("z", zoom.toFixed(2));
  if (invert != null) p.set("v", invert ? "1" : "0");
  if (sea != null) p.set("sea", String(Math.round(sea)));
  return "#" + p.toString();
}

// Fade to a deep-space colour, then navigate — hides the page reload so the
// transition feels like part of the zoom rather than a hard cut.
export function navigateWithFade(href) {
  const o = document.createElement("div");
  o.style.cssText =
    "position:fixed;inset:0;z-index:999;background:#05070d;opacity:0;" +
    "transition:opacity .24s ease;pointer-events:none";
  document.body.appendChild(o);
  requestAnimationFrame(() => {
    o.style.opacity = "1";
  });
  setTimeout(() => {
    location.href = href;
  }, 250);
}
