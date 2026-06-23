import { defineConfig } from "vite";

// base: "./" makes the built site portable — it works when served from a
// sub-path (e.g. GitHub Pages project page) as well as from a domain root.
export default defineConfig({
  base: "./",
  server: { host: true, port: 5173 },
});
