import { defineConfig } from 'vite';
// Tauri の開発サーバー（devUrl: http://localhost:1420）に合わせる
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'safari15', outDir: 'dist' }
});
