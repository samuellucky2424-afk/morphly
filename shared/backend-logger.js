import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_LOG_DIR = path.resolve(__dirname, '..', 'logs', 'backend');
const MAX_STRING_LENGTH = 4000;
const MAX_DEPTH = 5;
const SENSITIVE_KEY_PARTS = [
  'authorization',
  'apikey',
  'api_key',
  'servicekey',
  'service_key',
  'secret',
  'token',
  'cookie',
  'signature',
  'password',
  'bearer',
];

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isSensitiveKey(key) {
  const normalized = String(key || '').toLowerCase();
  return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part));
}

function truncateString(value) {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function serializeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? truncateString(error.stack) : null,
    };
  }

  if (typeof error === 'string') {
    return { message: truncateString(error) };
  }

  return sanitizeValue(error);
}

export function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[MaxDepthExceeded]';
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `[Buffer:${value.length}]`;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    if (typeof value.toJSON === 'function' && !isPlainObject(value)) {
      try {
        return sanitizeValue(value.toJSON(), depth + 1, seen);
      } catch {
        return String(value);
      }
    }

    if (!isPlainObject(value)) {
      return String(value);
    }

    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = isSensitiveKey(key)
        ? '[Redacted]'
        : sanitizeValue(nestedValue, depth + 1, seen);
    }

    return sanitized;
  }

  return String(value);
}

function normalizePayload(details) {
  const sanitized = sanitizeValue(details);
  if (isPlainObject(sanitized)) {
    return sanitized;
  }

  return { details: sanitized };
}

function getLogFilePath(channel) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(BACKEND_LOG_DIR, `${channel}-${date}.log`);
}

async function appendLog(channel, entry) {
  try {
    await fs.mkdir(BACKEND_LOG_DIR, { recursive: true });
    await fs.appendFile(getLogFilePath(channel), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    const fallback = serializeError(error);
    console.warn(`[backend:logger] Failed to append ${channel} log`, fallback);
  }
}

function emitConsole(channel, entry) {
  const line = JSON.stringify(entry);
  if (channel === 'errors') {
    console.error(`[backend:${channel}] ${line}`);
    return;
  }

  console.log(`[backend:${channel}] ${line}`);
}

export async function writeBackendLog(channel, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    channel,
    event,
    ...normalizePayload(details),
  };

  emitConsole(channel, entry);
  await appendLog(channel, entry);
  return entry;
}

export async function logRequestEvent(event, details = {}) {
  return writeBackendLog('requests', event, details);
}

export async function logPaymentEvent(event, details = {}) {
  return writeBackendLog('payments', event, details);
}

export async function logDbQueryEvent(event, details = {}) {
  return writeBackendLog('db-queries', event, details);
}

export async function logErrorEvent(event, error, details = {}) {
  return writeBackendLog('errors', event, {
    ...details,
    error: serializeError(error),
  });
}