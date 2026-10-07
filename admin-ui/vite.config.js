import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地管理后台：dev server :6183，/admin 与 /healthz 代理到本地网关 :18080。
// （本机 8080/5173/5175 已被其他项目占用；端口如再冲突可改这里或用 GATEWAY_URL 覆盖代理目标）
const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:18080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6183,
    strictPort: true, // 端口被占直接报错，避免悄悄跳到别的端口造成困惑
    proxy: {
      '/admin': gateway,
      '/healthz': gateway,
    },
  },
})
