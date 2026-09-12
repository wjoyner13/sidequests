import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Supabase is the real store. Until the `episodes` table exists (see
// supabase/episodes.sql) we fall back to a local JSON file so the app still
// works; the first successful Supabase call switches over permanently.
const FALLBACK_PATH = resolve(process.cwd(), '.data/episodes.json');
const TABLE_MISSING = new Set(['PGRST205', 'PGRST204', '42P01']);
const RATING_RANK = { positive: 0, neutral: 1, negative: 2, null: 3 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let usingFallback = false;

export function storeMode() {
  return usingFallback ? 'local-file' : 'supabase';
}

function isTableMissing(error) {
  return Boolean(error) && (TABLE_MISSING.has(error.code) || /schema cache|does not exist/i.test(error.message ?? ''));
}

async function readFallback() {
  try {
    return JSON.parse(await readFile(FALLBACK_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function writeFallback(rows) {
  await mkdir(dirname(FALLBACK_PATH), { recursive: true });
  await writeFile(FALLBACK_PATH, JSON.stringify(rows, null, 2));
}

// Runs the Supabase query; on a missing table, degrades to the local file.
async function withFallback(supabaseCall, fallbackCall) {
  if (!usingFallback) {
    const { data, error } = await supabaseCall();
    if (!isTableMissing(error)) {
      if (error) throw error;
      return data;
    }
    usingFallback = true;
    console.warn('Supabase table `episodes` not found — using .data/episodes.json until it exists.');
  }
  return fallbackCall();
}

export async function insertEpisodes(rows) {
  return withFallback(
    () => supabase.from('episodes').insert(rows).select(),
    async () => {
      const now = new Date().toISOString();
      const created = rows.map((row) => ({ ...row, id: randomUUID(), created_at: now, rated_at: null }));
      await writeFallback([...created, ...(await readFallback())]);
      return created;
    }
  );
}

export async function rateEpisode(id, rating) {
  const rated_at = new Date().toISOString();
  return withFallback(
    () => supabase.from('episodes').update({ rating, rated_at }).eq('id', id).select().single(),
    async () => {
      const rows = await readFallback();
      const target = rows.find((row) => row.id === id);
      if (!target) throw new Error('Episode not found');
      Object.assign(target, { rating, rated_at });
      await writeFallback(rows);
      return target;
    }
  );
}

export async function deleteEpisode(id) {
  return withFallback(
    () => supabase.from('episodes').delete().eq('id', id),
    async () => {
      const rows = await readFallback();
      await writeFallback(rows.filter((row) => row.id !== id));
      return null;
    }
  );
}

export async function listEpisodes({ rating, mood }) {
  const rows = await withFallback(
    () => {
      let builder = supabase.from('episodes').select();
      if (rating === 'not.null') builder = builder.not('rating', 'is', null);
      else if (rating === 'null') builder = builder.is('rating', null);
      else if (rating) builder = builder.eq('rating', rating);
      if (mood) builder = builder.eq('mood', mood);
      return builder;
    },
    async () => {
      let rows = await readFallback();
      if (rating === 'not.null') rows = rows.filter((row) => row.rating);
      else if (rating === 'null') rows = rows.filter((row) => !row.rating);
      else if (rating) rows = rows.filter((row) => row.rating === rating);
      if (mood) rows = rows.filter((row) => row.mood === mood);
      return rows;
    }
  );

  // Rating-first, then most recently rated. Postgres can't order these by name.
  return [...rows].sort((a, b) => {
    const diff = RATING_RANK[a.rating] - RATING_RANK[b.rating];
    if (diff !== 0) return diff;
    return new Date(b.rated_at ?? b.created_at) - new Date(a.rated_at ?? a.created_at);
  });
}
