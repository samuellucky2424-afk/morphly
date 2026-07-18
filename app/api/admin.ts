// @ts-nocheck
import { handleAdminRoute } from '../server/admin-handler.js';

export default async function adminApi(req, res) {
  const routeName = Array.isArray(req.query?.name) ? req.query.name[0] : req.query?.name;
  return handleAdminRoute(routeName, req, res);
}
