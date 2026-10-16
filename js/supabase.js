import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const IMAGE_BUCKET = 'recipe-images';

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce', persistSession: true } })
  : null;
