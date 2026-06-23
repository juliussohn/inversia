import { defineConfig } from "vite";

// On GitHub Pages this is served from the project sub-path /inversia/, so the
// production build needs an absolute base of "/inversia/" — a relative "./"
// base breaks whenever the URL loses its trailing slash. Dev still serves at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/inversia/" : "/",
  server: { host: true, port: 5173 },
}));
