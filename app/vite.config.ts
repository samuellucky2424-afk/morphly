import path from "path"
import fs from "fs"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiProxyTarget = env.API_PROXY_TARGET || env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  const adminPortalPlugin = {
    name: 'morphly-admin-portal',
    closeBundle() {
      const source = path.resolve(__dirname, '../morphly-admin-dashboard');
      const destination = path.resolve(__dirname, 'dist/private/morphly/login');
      fs.mkdirSync(destination, { recursive: true });
      for (const fileName of ['index.html', 'styles.css', 'app.js']) {
        fs.copyFileSync(path.join(source, fileName), path.join(destination, fileName));
      }
    },
  };

  return {
    base: './',
    plugins: [inspectAttr(), react(), adminPortalPlugin],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
