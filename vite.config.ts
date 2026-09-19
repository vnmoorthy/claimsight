import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Local dev: `vite` serves the SPA on :5173 (or --port) and proxies every
 * backend route to the `edgeone makers dev` server so the full ClaimSight
 * flow (SSE chat, evidence upload/polling, Refund Desk) works without a
 * separate CORS setup. Override the target with CLAIMSIGHT_BACKEND.
 */
const BACKEND = process.env.CLAIMSIGHT_BACKEND ?? 'http://localhost:8088'

const BACKEND_ROUTES = [
  // agents/
  '/claims', '/chat', '/stop',
  // cloud-functions/ (template)
  '/history', '/clear-history', '/conversations', '/delete-conversation',
  // cloud-functions/ (ClaimSight)
  '/upload-evidence', '/evidence-status', '/demo-evidence', '/orders-lookup',
  '/refund', '/replacement', '/claims-decision', '/stats', '/seed', '/agentx-emit',
  '/claim', '/twin-ready', '/twins', '/lab',
]

export default defineConfig({
  plugins: [react() as PluginOption],
  server: {
    proxy: Object.fromEntries(
      BACKEND_ROUTES.map(route => [route, { target: BACKEND, changeOrigin: true }]),
    ),
  },
})
