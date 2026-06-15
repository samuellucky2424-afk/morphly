// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../server/supabase-admin.js';
import { createEnsureUserWalletHandler } from '../../shared/ensure-user-wallet.js';

export default createEnsureUserWalletHandler({ supabaseAdmin, supabaseAdminConfigError });
