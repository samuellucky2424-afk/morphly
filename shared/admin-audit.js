import fs from 'fs/promises';
import path from 'path';

import { getBackendLogDir } from './backend-log-path.js';

function parseLogLine(line) {
  if (!line || !line.trim()) {
    return null;
  }

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function readAdminAuditLog(options = {}, supabaseAdmin = null) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(200, Number(options.limit))) : 50;
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }
  const backendLogDir = getBackendLogDir();

  try {
    const files = (await fs.readdir(backendLogDir))
      .filter((fileName) => fileName.endsWith('.log'))
      .sort()
      .reverse();

    const entries = [];

    for (const fileName of files) {
      const filePath = path.join(backendLogDir, fileName);
      const fileContents = await fs.readFile(filePath, 'utf8');
      const lines = fileContents.split(/\r?\n/).reverse();

      for (const line of lines) {
        const parsed = parseLogLine(line);
        if (!parsed) {
          continue;
        }

        entries.push(parsed);
        if (entries.length >= limit * 2) {
          break;
        }
      }

      if (entries.length >= limit * 2) {
        break;
      }
    }

    return entries
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
      .slice(0, limit);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
