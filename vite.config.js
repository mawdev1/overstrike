import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: false, host: '127.0.0.1' },
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
