import { RATINGS, rateEpisode } from '../../lib/store.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const { id, rating, feedback } = await req.json().catch(() => ({}));
  if (typeof id !== 'string' || !id) return json({ error: 'id is required' }, 400);
  if (!RATINGS.includes(rating)) {
    return json({ error: `rating must be one of ${RATINGS.join(', ')}` }, 400);
  }
  if (feedback !== undefined && typeof feedback !== 'string') {
    return json({ error: 'feedback must be a string' }, 400);
  }

  try {
    return json({ episode: await rateEpisode(id, rating, feedback) });
  } catch (err) {
    console.error('rate failed', err);
    return json({ error: err.message ?? 'Rating failed' }, 500);
  }
};

export const config = {
  path: '/api/rate',
  method: 'POST',
};
