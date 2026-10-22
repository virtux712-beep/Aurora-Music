import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // Three preloads, one per kind of renderer: the app window's capability surface, the sandbox
        // host's bridge (a hidden, fully offline renderer — see `main/scriptHost/host.ts`), and the
        // desktop-lyrics window's four-channel bridge.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'script-host': resolve(__dirname, 'src/preload/script-host.ts'),
          'desktop-lyrics': resolve(__dirname, 'src/preload/desktop-lyrics.ts'),
        },
        // Sandboxed preload scripts are executed as plain CommonJS: an ESM (.mjs) preload is
        // silently ignored when `sandbox: true`, which would break every IPC call.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [vue()],
    build: {
      rollupOptions: {
        // Two pages: the app shell, and the separate transparent desktop-lyrics window. Keeping them
        // apart means the lyric window never loads the app stores, router or source runtime.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'desktop-lyrics': resolve(__dirname, 'src/renderer/desktop-lyrics.html'),
        },
      },
    },
  },
})
