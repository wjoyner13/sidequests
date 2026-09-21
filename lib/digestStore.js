import { createClient } from '@supabase/supabase-js';

// Created per call so serverless invocations read the current environment.
function client() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// Health check: proves the function has working credentials and that the
// `digests` table exists. Handy for confirming a deploy's env vars.
export async function digestStoreStatus() {
  const missing = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    return { ok: false, store: 'supabase', error: `Missing env vars: ${missing.join(', ')}` };
  }

  const { error } = await client().from('digests').select('id').limit(1);
  return error ? { ok: false, store: 'supabase', error: error.message } : { ok: true, store: 'supabase' };
}

export async function insertDigest({ headline, topics }) {
  return unwrap(await client().from('digests').insert({ headline, topics }).select().single());
}

export async function listDigests(limit = 12) {
  return unwrap(await client().from('digests').select().order('created_at', { ascending: false }).limit(limit));
}

export async function deleteDigest(id) {
  return unwrap(await client().from('digests').delete().eq('id', id));
}
