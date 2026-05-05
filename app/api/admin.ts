// @ts-nocheck
import { handleAdminRoute } from '../server/admin-handler.js';

function normalizeRouteName(value) {
  if (Array.isArray(value)) {
    return normalizeRouteName(value[0]);
  }

  return typeof value === 'string' ? value.trim() : '';
}

export default async function handler(req, res) {
  return handleAdminRoute(normalizeRouteName(req.query?.route), req, res);
}