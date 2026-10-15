import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies /api to the local API server (services/api/src/local-server.ts on :8787).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { sourcemap: true },
});
