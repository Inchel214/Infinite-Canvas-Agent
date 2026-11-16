import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 监听所有网卡：同一局域网的平板/手机可通过 http://<本机IP>:5173 访问
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // 画布图片用相对路径 /images/...（后端持久化数据可跨设备复用），
    // 开发服务器把该前缀转发到后端静态服务
    proxy: {
      '/images': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
    },
  },
})
