export const DEFAULT_CREDIT_PACKAGES = [
  { name: 'Starter', credits: 500, priceNGN: 11500, isActive: true, sortOrder: 1 },
  { name: 'Basic', credits: 1000, priceNGN: 23000, isActive: true, sortOrder: 2 },
  { name: 'Pro', credits: 2000, priceNGN: 46000, isActive: true, sortOrder: 3 },
  { name: 'Enterprise', credits: 5000, priceNGN: 115000, isActive: true, sortOrder: 4 },
];

export function normalizeCreditPackage(record) {
  return {
    id: record.id,
    name: String(record.name || '').trim(),
    credits: Number(record.credits || 0),
    priceNGN: Number(record.price_ngn || 0),
    isActive: Boolean(record.is_active),
    status: record.status || (record.is_active ? 'active' : 'paused'),
    description: String(record.description || ''),
    isRecommended: Boolean(record.is_recommended),
    sortOrder: Number(record.sort_order || 0),
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null,
  };
}

export async function listCreditPackages(supabaseAdmin, options = {}) {
  const includeInactive = Boolean(options.includeInactive);
  let query = supabaseAdmin
    .from('credit_packages')
    .select('id, name, description, credits, price_ngn, is_active, status, is_recommended, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('credits', { ascending: true });

  if (!includeInactive) {
    query = query.eq('is_active', true).eq('status', 'active');
  }

  let { data, error } = await query;
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    let legacyQuery = supabaseAdmin.from('credit_packages').select('id, name, credits, price_ngn, is_active, sort_order, created_at, updated_at').order('sort_order', { ascending: true });
    if (!includeInactive) legacyQuery = legacyQuery.eq('is_active', true);
    ({ data, error } = await legacyQuery);
  }
  if (error) throw error;

  return (data || []).map(normalizeCreditPackage);
}

export async function updateCreditPackages(supabaseAdmin, packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('packages must be a non-empty array');
  }

  const updates = packages.map((pkg, index) => {
    const credits = Number(pkg.credits);
    const priceNGN = Number(pkg.priceNGN);
    const sortOrder = Number(pkg.sortOrder ?? index + 1);

    if (!pkg.id) {
      throw new Error('Each package update requires an id');
    }

    if (!Number.isFinite(credits) || credits <= 0) {
      throw new Error('credits must be a positive number');
    }

    if (!Number.isFinite(priceNGN) || priceNGN < 0) {
      throw new Error('priceNGN must be zero or greater');
    }

    return {
      id: pkg.id,
      name: String(pkg.name || '').trim() || `${credits} Credits`,
      credits: Math.round(credits),
      price_ngn: Number(priceNGN.toFixed(2)),
      is_active: Boolean(pkg.isActive),
      status: pkg.status || (pkg.isActive ? 'active' : 'paused'),
      description: String(pkg.description || ''),
      is_recommended: Boolean(pkg.isRecommended ?? pkg.featured),
      sort_order: Number.isFinite(sortOrder) ? Math.round(sortOrder) : index + 1,
      updated_at: new Date().toISOString(),
    };
  });

  if (updates.some((update) => update.is_recommended)) {
    const { error } = await supabaseAdmin.from('credit_packages').update({ is_recommended: false }).eq('is_recommended', true);
    if (error) throw error;
  }

  const results = [];
  for (const update of updates) {
    results.push(await supabaseAdmin
        .from('credit_packages')
        .update({
          name: update.name,
          credits: update.credits,
          price_ngn: update.price_ngn,
          is_active: update.is_active,
          status: update.status,
          description: update.description,
          is_recommended: update.is_recommended,
          sort_order: update.sort_order,
          updated_at: update.updated_at,
        })
        .eq('id', update.id));
  }

  const failedResult = results.find((result) => result?.error);
  if (failedResult?.error) {
    throw failedResult.error;
  }

  return listCreditPackages(supabaseAdmin, { includeInactive: true });
}

export async function createCreditPackage(supabaseAdmin, input) {
  const name = String(input?.name || '').trim(); const description = String(input?.description || '').trim();
  const credits = Number(input?.credits); const price = Number(input?.price ?? input?.priceNGN);
  const status = ['active','draft','paused'].includes(input?.status) ? input.status : 'draft';
  if (name.length < 2 || name.length > 80 || description.length > 240) throw new Error('Invalid package name or description');
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10000000) throw new Error('Credits must be a safe positive integer');
  if (!Number.isFinite(price) || price < 100 || price > 100000000) throw new Error('Invalid NGN price');
  if (input?.featured) await supabaseAdmin.from('credit_packages').update({ is_recommended: false }).eq('is_recommended', true);
  const { data, error } = await supabaseAdmin.from('credit_packages').insert({ name, description, credits, price_ngn: price.toFixed(2), status,
    is_active: status === 'active', is_recommended: Boolean(input?.featured) }).select().single();
  if (error) throw error; return normalizeCreditPackage(data);
}
