import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server serves `dist/` (same origin as /api — cookie sessions). `pnpm dev` proxies /api to a
// locally running server (`pnpm --filter @euta-cloud/server dev`, port 8080).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
