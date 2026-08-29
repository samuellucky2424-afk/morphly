const PLACEHOLDER_PATTERN = /^(?:your[_-]|replace[_-]?me|change[_-]?me|placeholder|\$\{|\$[a-z_])/i;

type PublicBuildEnvironment = Record<string, string | undefined>;

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholder(value: string): boolean {
  return !value || PLACEHOLDER_PATTERN.test(value);
}

export function validatePublicBuildEnvironment(
  environment: PublicBuildEnvironment,
  { requireHttps = true }: { requireHttps?: boolean } = {},
): void {
  const supabaseUrl = normalize(environment.VITE_SUPABASE_URL);
  const supabaseAnonKey = normalize(environment.VITE_SUPABASE_ANON_KEY);
  const errors: string[] = [];

  try {
    const parsedUrl = new URL(supabaseUrl);
    const validProtocol = requireHttps
      ? parsedUrl.protocol === 'https:'
      : parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
    if (!validProtocol || isPlaceholder(supabaseUrl)) {
      errors.push('VITE_SUPABASE_URL must be a valid public Supabase URL.');
    }
  } catch {
    errors.push('VITE_SUPABASE_URL must be a valid public Supabase URL.');
  }

  if (isPlaceholder(supabaseAnonKey) || supabaseAnonKey.length < 20) {
    errors.push('VITE_SUPABASE_ANON_KEY must contain the public anon/publishable key.');
  }

  if (errors.length > 0) {
    throw new Error(`Morphly public client configuration is invalid:\n- ${errors.join('\n- ')}`);
  }
}
