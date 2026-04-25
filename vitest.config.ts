import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      game: fileURLToPath(new URL('./src/game', import.meta.url)),
      layouts: fileURLToPath(new URL('./src/layouts', import.meta.url)),
      views: fileURLToPath(new URL('./src/views', import.meta.url)),
      components: fileURLToPath(new URL('./src/components', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      exclude: ['**/*.d.ts', '**/node_modules/**', '**/dist/**'],
    },
  },
})
