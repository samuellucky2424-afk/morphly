// @ts-nocheck
import { handleAdminRoute } from '../app/server/admin-handler.js';

export default async function adminApi(req, res) {
  try {
    const routeName = Array.isArray(req.query?.name) ? req.query.name[0] : req.query?.name;
    return await handleAdminRoute(routeName, req, res);
  } catch (error) {
    console.error('ADMIN_VERCEL_CRASH:', error);
    return res.status(500).json({ error: 'Admin API failure' });
  }
}
