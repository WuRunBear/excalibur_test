import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  name?: string
  version?: string
}

function toShortName(value: string) {
  const parts = value.split(/[^a-zA-Z0-9]+/g).filter(Boolean)
  const raw = (parts.length > 0 ? parts : [value])
    .map((p) => p[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
  return raw.slice(0, 4) || 'APP'
}

function toBName(value: string) {
  const parts = value
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
    .replace(/[^a-zA-Z0-9_]/g, '')

  if (!parts) return 'App'
  if (/^[0-9]/.test(parts)) return `App${parts}`
  return parts
}

function toHostValue(value?: string): true | string | undefined {
  const host = value?.trim()
  if (!host) return undefined
  return host === 'true' ? true : host
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHostsRaw = env.VITE_ALLOWED_HOSTS?.trim()
  const devHost = toHostValue(env.VITE_DEV_HOST)
  const previewHost = toHostValue(env.VITE_PREVIEW_HOST)
  const allowedHosts: true | string[] | undefined =
    !allowedHostsRaw
      ? undefined
      : allowedHostsRaw === 'all'
        ? true
        : allowedHostsRaw
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
  const server =
    allowedHosts || devHost ? { ...(allowedHosts ? { allowedHosts } : {}), ...(devHost ? { host: devHost } : {}) } : undefined
  const preview = previewHost
    ? {
        host: previewHost,
      }
    : undefined

  return {
    define: {
      __APP_INFO__: JSON.stringify({
        name: pkg.name ?? 'app',
        shortName: toShortName(pkg.name ?? 'app'),
        BName: toBName(pkg.name ?? 'app'),
        version: pkg.version ?? '0.0.0',
        buildTime: new Date().toISOString(),
      }),
    },
    preview,
    server,
    plugins: [
      tailwindcss(),
      vue(),
      vueJsx(),
      vueDevTools(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        game: fileURLToPath(new URL('./src/game', import.meta.url)),
        layouts: fileURLToPath(new URL('./src/layouts', import.meta.url)),
        views: fileURLToPath(new URL('./src/views', import.meta.url)),
        components: fileURLToPath(new URL('./src/components', import.meta.url)),
      },
    },
  }
})
