// apps/web/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    proxy: {
      '/tm':      { target: 'http://localhost:8787', changeOrigin: true },
      '/projects':{ target: 'http://localhost:8787', changeOrigin: true },
      '/repos':   { target: 'http://localhost:8787', changeOrigin: true },
      '/me':      { target: 'http://localhost:8787', changeOrigin: true },
      '/_static': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
