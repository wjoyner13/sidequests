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

export async function openEpisode(id) {
  const existing = unwrap(await client().from('episodes').select().eq('id', id).single());
  // rated_at doubles as "added to History": set it on first open so the
  // episode shows up before a rating, using a column the live table already has.
  if (existing.rated_at || existing.rating) return existing;
  return unwrap(
    await client()
      .from('episodes')
      .update({ rated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
  );
}

export async function deleteEpisode(id) {
  return unwrap(await client().from('episodes').delete().eq('id', id));
}

export async function listEpisodes({ rating, mood, history } = {}) {
  let builder = client().from('episodes').select();
  if (history) builder = builder.or('rating.not.is.null,rated_at.not.is.null');
  else if (rating === 'not.null') builder = builder.not('rating', 'is', null);
  else if (rating === 'null') builder = builder.is('rating', null);
  else if (rating) builder = builder.eq('rating', rating);
  if (mood) builder = builder.eq('mood', mood);

  const rows = unwrap(await builder);

  // History: unrated opens first (still waiting on a rating), then rating,
  // then most recently opened/rated. Other lists keep unrated last.
  const unratedRank = history ? -1 : 3;
  return [...rows].sort((a, b) => {
    const rankA = a.rating == null ? unratedRank : RATING_RANK[a.rating];
    const rankB = b.rating == null ? unratedRank : RATING_RANK[b.rating];
    const diff = rankA - rankB;
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
