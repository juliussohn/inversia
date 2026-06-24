import { defineConfig } from "vite";

// On GitHub Pages this is served from the project sub-path /inversia/, so the
// production build needs an absolute base of "/inversia/" — a relative "./"
// base breaks whenever the URL loses its trailing slash. Dev still serves at "/".
//
// Two pages: index.html (zoomable streaming map) and globe.html (3D globe).
// Asset filenames are kept stable (no content hash) so a cached index.html —
// GitHub Pages caches HTML ~10 min — keeps pointing at files that still exist
// after the next deploy.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/inversia/" : "/",
  server: { host: true, port: process.env.PORT ? +process.env.PORT : 5173 },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        globe: "globe.html",
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        // Pin the bundled CSS to a fixed name. Its chunk attribution can shift
        // as modules are added (e.g. a shared handoff module), but a cached
        // HTML must keep pointing at a file that still exists after deploy.
        assetFileNames: (info) =>
          (info.name || "").endsWith(".css")
            ? "assets/style.css"
            : "assets/[name][extname]",
      },
    },
  },
}));
