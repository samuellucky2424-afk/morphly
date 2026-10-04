import path from "path"
import fs from "fs"
import { buildSync } from 'esbuild';
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { validatePublicBuildEnvironment } from './src/lib/public-env-validation'

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
      for (const fileName of ['index.html', 'styles.css', 'app.js', 'engagement.js']) {
        fs.copyFileSync(path.join(source, fileName), path.join(destination, fileName));
      }
      fs.copyFileSync(path.resolve(__dirname, 'src/components/admin-engagement.css'), path.join(destination, 'engagement.css'));
      fs.copyFileSync(path.resolve(__dirname, 'src/styles/theme.css'), path.join(destination, 'theme.css'));
      buildSync({ entryPoints: [path.join(source, 'firebase-auth.js')], bundle: true, minify: true, platform: 'browser', nodePaths: [path.resolve(__dirname, 'node_modules')], outfile: path.join(destination, 'firebase.js') });
      const resetDestination = path.resolve(__dirname, 'dist/reset-password');
      fs.mkdirSync(resetDestination, { recursive: true });
      fs.writeFileSync(path.join(resetDestination, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Password reset</title><p>Open the password reset link from your Firebase email to choose a new password. <a href="/#/login">Return to sign in</a></p>');
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
