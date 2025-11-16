import { defineConfig } from "vite";

// GitHub Pages deploy base path (repo name). Adjust if publishing under user site.
export default defineConfig({
  base: "/csv-json-tool/",
  server: {
    port: 6767,
    host: true // allow LAN access if needed
  }
});
