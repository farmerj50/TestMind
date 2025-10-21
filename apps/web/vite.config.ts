// apps/web/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      // forward /tm/... to your API during dev
      '/tm': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
