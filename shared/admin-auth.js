export function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function extractBearerToken(req) {
  const authorization = getHeader(req, 'authorization');
  if (!authorization) {
    return null;
  }

  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function authenticateRequestUser(req, supabaseAdmin) {
  const token = extractBearerToken(req);
  if (!token) {
    return { error: 'Missing Authorization bearer token', status: 401 };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return { error: 'Invalid or expired access token', status: 401 };
  }

  return { user: data.user, token };
}

export async function getAdminMembership(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .select('role, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

export async function requireAdminContext(req, res, supabaseAdmin) {
  const authResult = await authenticateRequestUser(req, supabaseAdmin);
  if (authResult.error) {
    res.status(authResult.status).json({ error: authResult.error });
    return null;
  }

  const adminMembership = await getAdminMembership(supabaseAdmin, authResult.user.id);
  if (!adminMembership) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }

  return {
    user: authResult.user,
    admin: adminMembership,
  };
}