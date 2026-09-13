import { createClient } from '@supabase/supabase-js';

export const RATINGS = ['positive', 'neutral', 'negative'];

const RATING_RANK = { positive: 0, neutral: 1, negative: 2, null: 3 };

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
// `episodes` table exists. Handy for confirming a deploy's env vars.
export async function storeStatus() {
  const configured = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
    (key) => !process.env[key]
  );
  if (configured.length) {
    return { ok: false, store: 'supabase', error: `Missing env vars: ${configured.join(', ')}` };
  }

  const { error } = await client().from('episodes').select('id').limit(1);
  return error ? { ok: false, store: 'supabase', error: error.message } : { ok: true, store: 'supabase' };
}

export async function insertEpisodes(rows) {
  return unwrap(await client().from('episodes').insert(rows).select());
}

export async function rateEpisode(id, rating) {
  return unwrap(
    await client()
      .from('episodes')
      .update({ rating, rated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
  );
}

export async function deleteEpisode(id) {
  return unwrap(await client().from('episodes').delete().eq('id', id));
}

export async function listEpisodes({ rating, mood } = {}) {
  let builder = client().from('episodes').select();
  if (rating === 'not.null') builder = builder.not('rating', 'is', null);
  else if (rating === 'null') builder = builder.is('rating', null);
  else if (rating) builder = builder.eq('rating', rating);
  if (mood) builder = builder.eq('mood', mood);

  const rows = unwrap(await builder);

  // Rating-first, then most recently rated. Postgres can't order these by name.
  return [...rows].sort((a, b) => {
    const diff = RATING_RANK[a.rating] - RATING_RANK[b.rating];
    if (diff !== 0) return diff;
    return new Date(b.rated_at ?? b.created_at) - new Date(a.rated_at ?? a.created_at);
  });
}

export function episodeRows({ episodes, mood, topics, query }) {
  return episodes.map((ep) => ({
    ...ep,
    mood,
    topics: topics.length ? topics : null,
    query: query || null,
    rating: null,
  }));
}
