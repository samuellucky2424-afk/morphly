// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { createEnsureUserWalletHandler } from '../shared/ensure-user-wallet.js';

export default createEnsureUserWalletHandler({ supabaseAdmin, supabaseAdminConfigError });
