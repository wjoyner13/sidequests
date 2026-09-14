import { openEpisode } from '../../lib/store.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== 'string' || !id) return json({ error: 'id is required' }, 400);

  try {
    return json({ episode: await openEpisode(id) });
  } catch (err) {
    console.error('open failed', err);
    return json({ error: err.message ?? 'Open failed' }, 500);
  }
};

export const config = {
  path: '/api/open',
  method: 'POST',
};
