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

// Created the moment "Pull" is pressed, before the search has even started,
// so the page has an id to poll right away.
export async function insertPendingDigest() {
  return unwrap(await client().from('digests').insert({ status: 'pending' }).select().single());
}

export async function completeDigest(id, { headline, topics }) {
  return unwrap(
    await client().from('digests').update({ status: 'ready', headline, topics }).eq('id', id).select().single()
  );
}

export async function failDigest(id, error) {
  return unwrap(await client().from('digests').update({ status: 'error', error }).eq('id', id).select().single());
}

export async function getDigest(id) {
  return unwrap(await client().from('digests').select().eq('id', id).single());
}

// Only finished pulls show up in the history list — a pending or failed row
// is only ever looked at directly, by id, while its own poll is in flight.
export async function listDigests(limit = 12) {
  return unwrap(
    await client()
      .from('digests')
      .select()
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

export async function deleteDigest(id) {
  return unwrap(await client().from('digests').delete().eq('id', id));
}
