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
      // /projects is both an SPA route (/projects, /projects/:id) and an API
      // prefix. Browser navigation requests (Accept: text/html) must receive
      // index.html so React Router can take over; only XHR/fetch calls (which
      // carry Accept: application/json) should be forwarded to the API.
      '/projects': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        bypass(req) {
          if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
            return '/index.html';
          }
        },
      },
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
