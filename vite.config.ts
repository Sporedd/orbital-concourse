import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // GitHub Pages serves the project from https://sporedd.github.io/orbital-concourse/.
  base: process.env.GITHUB_PAGES === '1' ? '/orbital-concourse/' : '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
});
