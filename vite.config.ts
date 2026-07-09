import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['texlyre-busytex']
  },
  server: {
    fs: {
      strict: true
    }
  }
});
