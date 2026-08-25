import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Everything the dev server must be told to ignore. These are real directories
// in the repo root, not build output: a vendored ComfyUI (~84k files), the
// Python service checkouts and their venvs (~65k), and a packaged Electron
// build (~21k). Vite has no reason to look inside any of them — the app is
// entirely under src/ — but by default it crawls and watches all of it.
const IGNORED = [
  '**/comfyui/**',
  '**/thirdparty/**',
  '**/python-server/**',
  '**/release/**',
  '**/data/**',
  '**/dist/**',
  '**/logs/**',
  '**/.git/**',
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  optimizeDeps: {
    // THE startup fix. With `entries` unset, Vite's dependency scanner globs
    // `**/*.html` from the project root and treats every hit as an entry point
    // to crawl. In this repo that is 675 files — 603 of them Python coverage
    // reports under comfyui/venv/Lib/site-packages/colour/htmlcov — and it
    // follows their imports into ComfyUI's TypeScript sources, which do not
    // resolve. The scan then fails outright ("Failed to run dependency scan.
    // Skipping dependency pre-bundling"), deps get optimized lazily on first
    // request instead, and the browser is served a "optimized dependencies
    // changed. reloading" full reload once that finishes.
    //
    // Measured before this: ~4m47s of scanning before bundling even started.
    // index.html is the only real entry, so say so.
    entries: ['index.html'],
  },

  server: {
    // Chokidar otherwise watches those same ~170k vendored files, which costs
    // memory and CPU for the whole session, not just at startup.
    watch: { ignored: IGNORED },
    fs: {
      // Nothing under those trees should be reachable over the dev server.
      deny: ['**/.env*', '**/thirdparty/**', '**/comfyui/**'],
    },
  },
})
