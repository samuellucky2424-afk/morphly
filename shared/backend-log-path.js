import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_BACKEND_LOG_DIR = path.resolve(__dirname, '..', 'logs', 'backend');

function isServerlessRuntime() {
  return Boolean(
    process.env.VERCEL
    || process.env.LAMBDA_TASK_ROOT
    || process.env.AWS_LAMBDA_FUNCTION_NAME
  );
}

export function getBackendLogDir() {
  if (process.env.BACKEND_LOG_DIR && process.env.BACKEND_LOG_DIR.trim()) {
    return path.resolve(process.env.BACKEND_LOG_DIR.trim());
  }

  if (isServerlessRuntime()) {
    return path.join(process.env.TMPDIR || os.tmpdir(), 'morphly', 'logs', 'backend');
  }

  return LOCAL_BACKEND_LOG_DIR;
}
