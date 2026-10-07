import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      overlay: fileURLToPath(new URL('./overlay.html', import.meta.url)),
      placement: fileURLToPath(new URL('./placement.html', import.meta.url)),
      'quick-send': fileURLToPath(new URL('./quick-send.html', import.meta.url)),
    } },
  },
});
