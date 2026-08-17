import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: false, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
