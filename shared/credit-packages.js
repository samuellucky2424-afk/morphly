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
    sortOrder: Number(record.sort_order || 0),
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null,
  };
}

export async function listCreditPackages(supabaseAdmin, options = {}) {
  const includeInactive = Boolean(options.includeInactive);
  let query = supabaseAdmin
    .from('credit_packages')
    .select('id, name, credits, price_ngn, is_active, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('credits', { ascending: true });

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

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
      sort_order: Number.isFinite(sortOrder) ? Math.round(sortOrder) : index + 1,
      updated_at: new Date().toISOString(),
    };
  });

  const results = await Promise.all(
    updates.map((update) =>
      supabaseAdmin
        .from('credit_packages')
        .update({
          name: update.name,
          credits: update.credits,
          price_ngn: update.price_ngn,
          is_active: update.is_active,
          sort_order: update.sort_order,
          updated_at: update.updated_at,
        })
        .eq('id', update.id),
    ),
  );

  const failedResult = results.find((result) => result?.error);
  if (failedResult?.error) {
    throw failedResult.error;
  }

  return listCreditPackages(supabaseAdmin, { includeInactive: true });
}