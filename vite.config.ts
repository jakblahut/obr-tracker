import { defineConfig, Plugin } from "vite";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * The manifest uses root paths for local dev. When hosted under a subpath
 * (GitHub Pages), rewrite them to absolute URLs from SITE_URL.
 */
function manifestUrls(): Plugin {
  return {
    name: "manifest-urls",
    apply: "build",
    closeBundle() {
      const site = process.env.SITE_URL;
      if (!site) return;
      const file = resolve(__dirname, "dist/manifest.json");
      const json = readFileSync(file, "utf8").replace(/"\/([^"]*)"/g, (_, path) => `"${new URL(path, site)}"`);
      writeFileSync(file, json);
    },
  };
}

export default defineConfig({
  base: "./",
  server: { cors: true },
  plugins: [manifestUrls()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "background.html"),
      },
    },
  },
});
