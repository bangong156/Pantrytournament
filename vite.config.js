import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        roundrobin: resolve(import.meta.dirname, 'roundrobin.html'),
        athletes: resolve(import.meta.dirname, 'athletes.html'),
      },
    },
  },
});
