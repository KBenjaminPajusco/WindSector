import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (https://<user>.github.io/<repo>/) and locally.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
});
