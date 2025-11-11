import { defineConfig } from "vite";

// If your repo is NOT <username>.github.io, GitHub Pages serves it under /<repo>.
// Set base to "/<repo-name>/" so assets resolve correctly.
// Example: base: "/csv-to-json-tool/"
export default defineConfig({
  base: "/csv-json-tool/"
});
