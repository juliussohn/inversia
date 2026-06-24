/* ------------------------------------------------------------------ *
 *  Shareable view state, encoded in the URL hash. The globe and map are now
 *  one page, so this is no longer a page-to-page handoff — it's a deep link:
 *  a URL that restores where you were looking and how the world was set.
 *
 *  Hash format:  #lat=..&lon=..&z=..&v=<0|1>&sea=<m>
 *    lat,lon : centre of the view, degrees
 *    z       : zoom (≥3 opens straight into the map; lower lands on the globe)
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
