import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const https = process.env.VITE_HTTPS_KEY_FILE && process.env.VITE_HTTPS_CERT_FILE ? {
  key: readFileSync(process.env.VITE_HTTPS_KEY_FILE),
  cert: readFileSync(process.env.VITE_HTTPS_CERT_FILE),
} : undefined;

export default defineConfig({
  server: {
    port: 5180,
    strictPort: false,
    host: '127.0.0.1',
    https,
    // Mirror nginx's production same-origin API path. This preserves httpOnly refresh-cookie
    // and SameSite behaviour in development instead of requiring a permissive CORS mode.
    proxy: {
      '/v1': {
        target: process.env.VITE_PLATFORM_PROXY_TARGET || 'http://127.0.0.1:8090',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    /**
     * `hidden` still writes the .map next to the bundle — so a crash report can be
     * symbolicated by anyone who has the file — but omits the `//# sourceMappingURL`
     * comment, so no browser ever asks for it. At 4.8 MB against a 1.15 MB bundle the
     * map was four times the size of the game and shipped to every visitor who opened
     * devtools; nothing in the boot path needs it.
     */
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 2000,
  },
});
