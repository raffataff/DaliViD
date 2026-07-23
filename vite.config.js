import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base: './'` emits relative asset URLs so the build works when served from a
// subpath like https://raffataff.github.io/DaliViD/ (GitHub Pages project site).
// Relative base is used instead of a hard-coded '/DaliViD/' so the site is immune
// to repo renames and the case-sensitivity of GitHub Pages project URLs.
export default defineConfig({
  plugins: [react()],
  base: './',
})
