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
    host: true,
    port: 5173,
    proxy: {
      '/tm':       { target: 'http://localhost:8787', changeOrigin: true },
      '/projects': { target: 'http://localhost:8787', changeOrigin: true },
      '/repos':    { target: 'http://localhost:8787', changeOrigin: true },
      '/me':       { target: 'http://localhost:8787', changeOrigin: true },
      '/_static':  { target: 'http://localhost:8787', changeOrigin: true },
      '/auth':     { target: 'http://localhost:8787', changeOrigin: true },
      '/github':   { target: 'http://localhost:8787', changeOrigin: true },
    },
  },

  preview: {
    host: true,
    port: Number(process.env.PORT) || 4173,
    allowedHosts: [
      'testmind-web-production.up.railway.app',
      'testmindai.com', // keep for later if/when domain is real
    ],
  },
})
