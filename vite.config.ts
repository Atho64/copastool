import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { readFileSync } from 'fs';

// Single source of truth for the app version: package.json.
// `npm run version:check` (also enforced in CI) keeps tauri.conf.json, Cargo.toml
// and the README badge in sync with it.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
const APP_VERSION = `v${pkg.version}`;

/** Replaces the __APP_VERSION__ placeholder in index.html (hero badge). */
function htmlAppVersion(): Plugin {
  return {
    name: 'copastool-html-app-version',
    transformIndexHtml(html: string) {
      return html.replace(/__APP_VERSION__/g, APP_VERSION);
    },
  };
}

export default defineConfig(() => ({
  base: './',
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
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
    htmlAppVersion(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.jpg', 'icon.png', 'icon.svg', 'notif.mp3'],
      workbox: {
        // The Kuromoji dictionaries (~17 MB in public/dict) are deliberately kept out
        // of the precache manifest so the first launch only pulls the ~1 MB app shell.
        // They are cached on demand the first time furigana is used (see runtimeCaching),
        // and stay available offline from then on.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /\/dict\/.*\.dat\.gz$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'copastool-kuromoji-dict',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
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
            src: 'icon.png',
            sizes: '1024x1024',
            type: 'image/png',
            purpose: 'any'
          },
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
