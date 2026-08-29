import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAppDirectory = path.resolve(moduleDirectory, '..');

function normalizeMode(mode) {
  const candidate = typeof mode === 'string' ? mode.trim() : '';
  return /^[a-z0-9_-]+$/i.test(candidate) ? candidate : 'development';
}

export function getMorphlyEnvironmentFileCandidates({
  mode = process.env.NODE_ENV || 'development',
  appDirectory = defaultAppDirectory,
  workspaceDirectory = path.resolve(appDirectory, '..'),
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const fileNames = [
    `.env.${normalizedMode}.local`,
    `.env.${normalizedMode}`,
    ...(normalizedMode === 'test' ? [] : ['.env.local']),
    '.env',
  ];
  const directories = [...new Set([
    path.resolve(workspaceDirectory),
    path.resolve(appDirectory),
  ])];

  return directories.flatMap((directory) => (
    fileNames.map((fileName) => path.join(directory, fileName))
  ));
}

export function loadMorphlyEnvironment({
  processEnvironment = process.env,
  ...options
} = {}) {
  const loadedFiles = [];

  for (const candidatePath of getMorphlyEnvironmentFileCandidates(options)) {
    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
      continue;
    }

    const parsedEnvironment = dotenv.parse(fs.readFileSync(candidatePath));
    for (const [name, value] of Object.entries(parsedEnvironment)) {
      if (processEnvironment[name] === undefined) {
        processEnvironment[name] = value;
      }
    }
    loadedFiles.push(candidatePath);
  }

  return { loadedFiles };
}
