import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves a project site from /<repo-name>/, not the domain
  // root, so built asset paths need that prefix or they 404. Netlify and
  // local dev serve from the root, so this only applies when the Pages
  // workflow sets GITHUB_PAGES=true for the build.
  base: process.env.GITHUB_PAGES ? '/visualisationtool/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 8080,
    strictPort: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
