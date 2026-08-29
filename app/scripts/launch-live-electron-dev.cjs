const { spawn } = require('node:child_process');

const DEPLOYED_APP_ORIGIN = 'https://morphly-alpha.vercel.app';
const PUBLIC_CONFIG_URL = `${DEPLOYED_APP_ORIGIN}/api/public-config`;

function validatePublicConfig(config) {
  const supabaseUrl = typeof config?.supabaseUrl === 'string'
    ? config.supabaseUrl.trim()
    : '';
  const supabaseAnonKey = typeof config?.supabaseAnonKey === 'string'
    ? config.supabaseAnonKey.trim()
    : '';

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error('The live backend returned an invalid public Supabase URL.');
  }

  if (parsedUrl.protocol !== 'https:' || supabaseAnonKey.length < 20) {
    throw new Error('The live backend public configuration is incomplete.');
  }

  return { supabaseUrl: parsedUrl.toString(), supabaseAnonKey };
}

async function fetchPublicConfig() {
  const response = await fetch(PUBLIC_CONFIG_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`The live backend returned HTTP ${response.status} for its public configuration.`);
  }

  return validatePublicConfig(await response.json());
}

async function main() {
  const publicConfig = await fetchPublicConfig();
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm did not provide its executable entry point.');
  }

  const childEnvironment = {
    ...process.env,
    VITE_API_PROXY_TARGET: DEPLOYED_APP_ORIGIN,
    VITE_API_URL: DEPLOYED_APP_ORIGIN,
    VITE_SUPABASE_URL: publicConfig.supabaseUrl,
    VITE_SUPABASE_ANON_KEY: publicConfig.supabaseAnonKey,
  };

  console.info('Starting Morphly Desktop against the live Vercel backend.');
  console.info('Public client configuration: verified (values hidden).');

  const child = spawn(process.execPath, [npmCliPath, 'run', 'electron:dev:live:inner'], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: false,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  child.on('error', (error) => {
    console.error(`Unable to launch the live desktop development runtime: ${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(`Unable to prepare the live desktop development runtime: ${error.message}`);
  process.exitCode = 1;
});
