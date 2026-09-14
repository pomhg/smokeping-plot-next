import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev` the API is proxied to a locally running backend
// (go run ./cmd/smokeping-plot-next). Override with VITE_API_TARGET.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
});
