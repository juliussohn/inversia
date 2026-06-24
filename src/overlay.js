/* ------------------------------------------------------------------ *
 *  Inversia — vector overlay (Canvas2D)
 *
 *  One 2D canvas floats above whichever WebGL view is active and draws the
 *  procedural vector features (borders now; cities, lakes, labels later). It is
 *  deliberately projection-agnostic: each frame the active view hands it a
 *  `project(lon, lat) → { x, y, vis }` function, and the overlay just plots the
 *  geometry through it. Swap the globe for the map and only `project` changes —
 *  the geometry and the drawing code stay identical.
 *
 *  Drawing dispatches on geometry `kind`, so a new feature type is a new case,
 *  not a new renderer.
 * ------------------------------------------------------------------ */

// Per-type look. New feature types add an entry; borders for now.
const STYLE = {
  borders: { width: 1.4, halo: 3.2, color: "rgba(255,243,214,0.92)", haloColor: "rgba(20,12,4,0.55)" },
};

export function createOverlay(canvas) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;

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

  // Draw every enabled feature this frame. `features` is the list the layer
  // exposes: [{ id, kind, data, type }]. `project` comes from the active view.
  function render(project, features) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!project || !features || !features.length) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const f of features) {
      if (f.kind === "segments") drawSegments(ctx, project, f);
      // future: else if (f.kind === "points") drawPoints(...)
      //         else if (f.kind === "polygons") drawPolygons(...)
    }
  }

  return { canvas, render, resize, get size() { return { W, H }; } };
}

// Stroke a flat [lon1,lat1,lon2,lat2, …] buffer. Two passes — a dark halo then
// the bright line — so borders stay legible over any terrain colour. Segments
// that wrap the screen seam or dip behind the globe's limb are skipped.
function drawSegments(ctx, project, feature) {
  const s = STYLE[feature.type] || STYLE.borders;
  const d = feature.data;
  const seamGuard = ctx.canvas.width; // any jump bigger than this ⇒ wrap seam

  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    for (let i = 0; i < d.length; i += 4) {
      const a = project(d[i], d[i + 1]);
      const b = project(d[i + 2], d[i + 3]);
      if (!a.vis || !b.vis) continue;
      if (Math.abs(a.x - b.x) > seamGuard * 0.5) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.lineWidth = pass === 0 ? s.width + s.halo : s.width;
    ctx.strokeStyle = pass === 0 ? s.haloColor : s.color;
    ctx.stroke();
  }
}
