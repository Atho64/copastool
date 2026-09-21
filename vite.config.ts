import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig(() => ({
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  resolve: {
    alias: {
      'path': 'path-browserify',
      'zlibjs/bin/gunzip.min.js': path.resolve(__dirname, 'src/zlib-shim.ts'),
    },
  },
  build: {
    outDir: 'dist',
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'es2021',
    rollupOptions: {
      input: 'index.html',
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.jpg', 'icon.svg', 'notif.mp3', 'dict/*.dat.gz'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,woff2,dat.gz}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: 'Copas Tool',
        short_name: 'Copas Tool',
        description: 'Alat bantu penerjemahan string dengan dukungan AI',
        theme_color: '#161412',
        background_color: '#0f0e0d',
        display: 'standalone',
        start_url: './',
        icons: [
          {
            src: 'icon.jpg',
            sizes: '784x784',
            type: 'image/jpeg',
            purpose: 'any maskable'
          },
          {
            src: 'icon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
}));
