import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const isTauri = !!process.env.TAURI_ENV_PLATFORM

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: isTauri ? './dist' : '../public',
    emptyOutDir: true,
  },
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    // Tauri expects a fixed port; fail if it's not available
    strictPort: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4637',
    },
  },
  // env variables starting with TAURI_ are exposed to the frontend
  envPrefix: ['VITE_', 'TAURI_'],
})
