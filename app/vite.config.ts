import path from "path"
import fs from "fs"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { validatePublicBuildEnvironment } from './build/public-env-validation'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const workspaceDirectory = path.resolve(__dirname, '..');
  const env = loadEnv(mode, workspaceDirectory, '');
  const runtimeEnv = { ...env, ...process.env };
  validatePublicBuildEnvironment(runtimeEnv, {
    requireHttps: command === 'build' && mode === 'production',
  });
  const apiProxyTarget = runtimeEnv.API_PROXY_TARGET
    || runtimeEnv.VITE_API_PROXY_TARGET
    || 'http://localhost:3000';

  const adminPortalPlugin = {
    name: 'morphly-admin-portal',
    closeBundle() {
      const source = path.resolve(__dirname, '../morphly-admin-dashboard');
      const destination = path.resolve(__dirname, 'dist/private/morphly/login');
      fs.mkdirSync(destination, { recursive: true });
      for (const fileName of ['index.html', 'styles.css', 'app.js']) {
        fs.copyFileSync(path.join(source, fileName), path.join(destination, fileName));
      }
      fs.copyFileSync(
        path.resolve(__dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'),
        path.join(destination, 'supabase.js'),
      );
      const resetDestination = path.resolve(__dirname, 'dist/reset-password');
      fs.mkdirSync(resetDestination, { recursive: true });
      fs.copyFileSync(path.join(source, 'reset-password.html'), path.join(resetDestination, 'index.html'));
    },
  };

  return {
    base: './',
    envDir: workspaceDirectory,
    plugins: [inspectAttr(), react(), adminPortalPlugin],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    // Decart creates frame-metadata-worker.js through import.meta.url at
    // runtime. Pre-bundling the SDK moves the parent module into .vite/deps
    // without copying that sibling worker, which breaks every realtime start.
    optimizeDeps: {
      exclude: ['@decartai/sdk'],
      // The excluded SDK imports p-retry, which in turn default-imports its
      // CommonJS-only retry dependency. Optimize that exact nested copy so
      // the browser receives a valid ESM interop wrapper.
      include: ['@decartai/sdk > p-retry > retry'],
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
