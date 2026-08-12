import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Content-Security-Policy for the production build.
 *
 * DaliViD is a purely local app — it never legitimately talks to another origin
 * — so pinning connect-src to 'self'/blob:/data: means an injected or tampered
 * script has nowhere to send the user's media, project data or camera frames.
 * That turns a full site compromise from "silent exfiltration" into "defacement",
 * which is the single highest-leverage mitigation available to a static host.
 *
 * Notes:
 * - blob: is required for connect-src/media-src: imported media, waveform
 *   decoding and the export mixdown all fetch their own object URLs.
 * - style-src needs 'unsafe-inline' because Monaco injects theme styles at runtime.
 * - frame-ancestors is deliberately absent: it is ignored in a <meta> CSP and
 *   would only log a console warning. Clickjacking cover needs a real header,
 *   which GitHub Pages cannot set.
 *
 * ── The one exception to "never talks to another origin" ──
 * GOOGLE_FONTS_ORIGINS widens connect-src by exactly two hosts so the Google
 * Fonts importer (src/utils/googleFonts.js) can fetch a family the user asked
 * for by name. This is a real, if narrow, softening of the paragraph above, and
 * is worth understanding before keeping it:
 *
 *   • connect-src only. font-src stays 'self' data: because the woff2 is fetched
 *     as bytes and registered through FontFace — a Google stylesheet never
 *     enters the render path, so there is no per-visit request and no per-visit
 *     IP leak. That is the distinction from the @import this project removed.
 *   • Two named hosts, not a wildcard. An injected script gains the ability to
 *     encode data into a URL aimed at fonts.gstatic.com and nothing more;
 *     exfiltration to an attacker-controlled origin is still blocked.
 *   • Fetched fonts are stored in the project, so a family is downloaded once
 *     ever rather than once per session, and the app still works offline.
 *
 * To drop the feature and restore the original policy: remove
 * GOOGLE_FONTS_ORIGINS from connect-src below, delete src/utils/googleFonts.js,
 * and remove the "Google Fonts…" buttons from FontPicker and FontsTab.
 */
const GOOGLE_FONTS_ORIGINS = 'https://fonts.googleapis.com https://fonts.gstatic.com'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  `connect-src 'self' blob: data: ${GOOGLE_FONTS_ORIGINS}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

// Build-only: the dev server needs inline scripts and a websocket for HMR, so
// applying the same policy to `npm run dev` would break the workflow the policy
// is meant to protect.
function cspPlugin() {
  return {
    name: 'dalivid-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend',
      }]
    },
  }
}

// https://vite.dev/config/
// `base: './'` emits relative asset URLs so the build works when served from a
// subpath like https://raffataff.github.io/DaliViD/ (GitHub Pages project site).
// Relative base is used instead of a hard-coded '/DaliViD/' so the site is immune
// to repo renames and the case-sensitivity of GitHub Pages project URLs.
export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: './',
})
