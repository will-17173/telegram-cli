import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Fixed port so the Tauri desktop shell (devUrl) can reach the dev server.
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
